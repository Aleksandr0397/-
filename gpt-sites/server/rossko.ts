import { SaxesParser } from "saxes";
import { InputError } from "../lib/inventory-domain";
import type { RosskoOptions, RosskoOffer, RosskoWave } from "../lib/rossko";
export type RosskoEnv = { SUPPLIER_CREDENTIALS_KEY?: string; ROSSKO_KEY1?: string; ROSSKO_KEY2?: string; ROSSKO_SETUP_KEY?: string };
export type RosskoKeys = { key1: string; key2: string };
const ns = "https://api.rossko.ru/", soap = "http://schemas.xmlsoap.org/soap/envelope/";
const limit = 2_000_000;
type Node = { name: string; namespace: string; text: string; children: Node[] };
const children = (n: Node | undefined, name: string) => n?.children.filter(x => x.name.toLowerCase() === name.toLowerCase()) ?? [];
const child = (n: Node | undefined, name: string) => children(n, name)[0];
const value = (n: Node | undefined, name: string) => child(n, name)?.text.trim() ?? "";
const xmlEscape = (s: string) => s.replace(/[<>&"']/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[c]!));
function parse(xml: string, method: string): Node {
  const invalid = () => new InputError("ROSSKO вернул некорректный ответ. Повторите проверку позже.", 502);
  if (new TextEncoder().encode(xml).length > limit) throw invalid();
  const parser = new SaxesParser({ xmlns: true });
  const roots: Node[] = [], stack: Node[] = []; let count = 0;
  parser.on("doctype", () => { throw invalid(); });
  parser.on("error", () => { throw invalid(); });
  parser.on("opentag", tag => {
    if (++count > 50000 || stack.length >= 24) throw invalid();
    const node: Node = { name: tag.local, namespace: tag.uri, text: "", children: [] };
    (stack.length ? stack[stack.length - 1].children : roots).push(node); stack.push(node);
  });
  const addText = (text: string) => { if (stack.length) stack[stack.length - 1].text += text; };
  parser.on("text", addText); parser.on("cdata", addText); parser.on("closetag", () => { stack.pop(); });
  try { parser.write(xml).close(); } catch { throw invalid(); }
  const root = roots[0], body = child(root, "Body");
  if (roots.length !== 1 || root.name !== "Envelope" || root.namespace !== soap || body?.namespace !== soap) throw invalid();
  if (child(body, "Fault")) throw new InputError("ROSSKO отклонил запрос. Проверьте оба ключа и доступ к API.", 502);
  const response = child(body, method + "Response"), result = child(response, { GetSearch: "SearchResult", GetCheckoutDetails: "CheckoutDetailsResult", GetDeliveryDetails: "DeliveryDetailsResult" }[method as "GetSearch" | "GetCheckoutDetails" | "GetDeliveryDetails"]);
  if (!response || ![ns, "http://api.rossko.ru/"].includes(response.namespace) || !result) throw invalid();
  if (!["true", "1"].includes(value(result, "success").toLowerCase())) {
    const message = value(result, "message").toLowerCase();
    if (/адрес.*(?:не указан|не найден|обязател|укажите)|(?:укажите|не указан).*адрес|address.*(?:required|missing|not (?:specified|found))/.test(message)) throw new InputError("ROSSKO требует адрес доставки для этого запроса. Адрес не передаётся по выбранной настройке, поэтому цены и сроки пока недоступны.", 409);
    if (method === "GetSearch" && /nothing found|no (?:results|parts)|ничего не найдено|не найден/.test(message)) return { ...result, children: [] };
    if (/не осуществляется доставка|не поддерживается доставка/.test(message)) throw new InputError("ROSSKO не разрешил выбранную доставку на ваш адрес. Уточните настройки доставки у менеджера ROSSKO.", 409);
    if (/limit|лимит|too many/.test(message)) throw new InputError("Достигнут лимит запросов ROSSKO. Повторите поиск позже.", 429);
    throw new InputError("ROSSKO не подтвердил запрос. Проверьте оба ключа, настройки доставки и доступ к API.", 502);
  }
  return result;
}
async function call(method: "GetCheckoutDetails" | "GetSearch" | "GetDeliveryDetails", keys: RosskoKeys, fields: Record<string, string>, transport: typeof fetch) {
  const url = "https://api.rossko.ru/service/v2.1/" + method;
  const payload = Object.entries({ KEY1: keys.key1, KEY2: keys.key2, ...fields }).map(([key, v]) => `<${key}>${xmlEscape(v)}</${key}>`).join("");
  let response: Response;
  try { response = await transport(url, { method: "POST", redirect: "manual", signal: AbortSignal.timeout(15000), headers: { "Content-Type": "text/xml; charset=utf-8", SOAPAction: url }, body: `<soap:Envelope xmlns:soap="${soap}"><soap:Body><${method} xmlns="${ns}">${payload}</${method}></soap:Body></soap:Envelope>` }); }
  catch { throw new InputError("Не удалось связаться с ROSSKO. Повторите запрос позже.", 502); }
  if (!response.ok) throw new InputError("Сервис ROSSKO недоступен (HTTP " + response.status + "). Повторите запрос позже.", 502);
  if (Number(response.headers.get("Content-Length") ?? 0) > limit) throw new InputError("Ответ ROSSKO слишком большой.", 502);
  const reader = response.body?.getReader(); if (!reader) throw new InputError("ROSSKO вернул пустой ответ.", 502);
  const chunks: Uint8Array[] = []; let size = 0;
  try { for (;;) { const item = await reader.read(); if (item.done) break; size += item.value.length; if (size > limit) { await reader.cancel(); throw new InputError("Ответ ROSSKO слишком большой.", 502); } chunks.push(item.value); } }
  catch (error) { if (error instanceof InputError) throw error; throw new InputError("Ответ ROSSKO не получен полностью. Повторите запрос.", 502); }
  finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0; for (const part of chunks) { bytes.set(part, offset); offset += part.length; }
  return parse(new TextDecoder().decode(bytes), method);
}
export async function rosskoDetails(keys: RosskoKeys, transport: typeof fetch = fetch): Promise<RosskoOptions> {
  const result = await call("GetCheckoutDetails", keys, {}, transport);
  const deliveries = children(child(result, "DeliveryType"), "delivery").slice(0, 100).map(d => ({ id: value(d, "id").slice(0, 80), name: value(d, "name").slice(0, 400) })).filter(d => d.id && d.name);
  if (!deliveries.length) throw new InputError("ROSSKO принял ключи, но не вернул способы доставки. Обратитесь к менеджеру ROSSKO.", 502);
  const addresses = children(child(result, "DeliveryAddress"), "address").slice(0, 200).map(a => {
    const addressDelivery = child(a, "Delivery"), ids = child(addressDelivery, "ids");
    const deliveryIds = addressDelivery ? (ids?.children.length ? children(ids, "id").map(d => d.text.trim()) : children(addressDelivery, "ids").map(d => d.text.trim())).slice(0, 100) : [];
    const city = value(a, "city"), street = value(a, "street"), house = value(a, "house"), office = value(a, "office");
    return { id: Number(value(a, "id")), label: [city, street, house + office].filter(Boolean).join(", ").slice(0, 600), city, street, house, office, deliveryIds };
  }).filter(a => Number.isSafeInteger(a.id) && a.id > 0);
  return { deliveries, addresses };
}
function integer(input: string, min: number, max: number): number | null { if (!/^\d+$/.test(input)) return null; const n = Number(input); return Number.isSafeInteger(n) && n >= min && n <= max ? n : null; }
function cents(input: string): number | null { const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(input); if (!m) return null; const n = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0")); return Number.isSafeInteger(n) && n > 0 && n <= 1_000_000_000 ? n : null; }
export async function rosskoSearch(keys: RosskoKeys, query: { query: string; deliveryId: string }, transport: typeof fetch = fetch): Promise<RosskoOffer[]> {
  const result = await call("GetSearch", keys, { text: query.query, delivery_id: query.deliveryId }, transport);
  const offers: RosskoOffer[] = [], ids = new Set<string>();
  function visit(part: Node, analogue: boolean, depth = 0) {
    if (depth > 2 || offers.length >= 1000) return;
    const guid = value(part, "guid").slice(0, 120), code = value(part, "partnumber").slice(0, 80), brand = value(part, "brand").slice(0, 100), name = value(part, "name").slice(0, 400);
    if (guid && code && name) for (const s of children(child(part, "stocks"), "stock").slice(0, 100)) {
      const stockId = value(s, "id").slice(0, 120), priceCents = cents(value(s, "price")), stock = integer(value(s, "count"), 0, 10_000_000), multiplicity = integer(value(s, "multiplicity"), 1, 100000), leadDays = integer(value(s, "delivery"), 0, 365), type = integer(value(s, "type"), 0, 3);
      const offerId = JSON.stringify([guid, stockId]);
      if (!stockId || priceCents === null || stock === null || multiplicity === null || leadDays === null || type === null || ids.has(offerId)) continue;
      ids.add(offerId); offers.push({ offerId, guid, stockId, code, brand, name, priceCents, stock, multiplicity, leadDays, type, analogue, description: value(s, "description").slice(0, 400), deliveryStart: apiDate(value(s, "deliveryStart")), deliveryEnd: apiDate(value(s, "deliveryEnd")) });
      if (offers.length >= 1000) break;
    }
    for (const cross of children(child(part, "crosses"), "Part").slice(0, 80)) visit(cross, true, depth + 1);
  }
  for (const part of children(child(result, "PartsList"), "Part").slice(0, 80)) visit(part, false);
  return offers;
}
function apiDate(input: string): string | null {
  if (!/^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})?$/.test(input) || !Number.isFinite(Date.parse(input))) return null;
  const calendar = new Date(input.slice(0, 10) + "T12:00:00Z");
  return calendar.toISOString().slice(0, 10) === input.slice(0, 10) ? input : null;
}
export async function rosskoDelivery(keys: RosskoKeys, date: string, deliveryId: string, transport: typeof fetch = fetch): Promise<RosskoWave[]> {
  const result = await call("GetDeliveryDetails", keys, { date }, transport), waves: RosskoWave[] = [];
  for (const d of children(child(result, "Deliveries"), "Delivery")) {
    if (value(d, "id") !== deliveryId) continue;
    for (const w of children(d, "Wave").slice(0, 100)) {
      const deliveryStart = apiDate(value(w, "deliveryStart")), deliveryEnd = apiDate(value(w, "deliveryEnd")), timeLimit = apiDate(value(w, "timeLimit"));
      if (deliveryStart && deliveryEnd && timeLimit) waves.push({ deliveryStart, deliveryEnd, timeLimit });
    }
  }
  return waves;
}
const enc = new TextEncoder();
async function encryptionKey(env: RosskoEnv) {
  if (!env.SUPPLIER_CREDENTIALS_KEY || !/^[a-f0-9]{64}$/i.test(env.SUPPLIER_CREDENTIALS_KEY)) throw new InputError("Хранилище ключей API ещё не настроено.", 503);
  return crypto.subtle.importKey("raw", Uint8Array.from(env.SUPPLIER_CREDENTIALS_KEY.match(/../g)!, x => parseInt(x, 16)), "AES-GCM", false, ["encrypt", "decrypt"]);
}
export async function sealKeys(env: RosskoEnv, supplierId: string, keys: RosskoKeys) {
  const iv = crypto.getRandomValues(new Uint8Array(12)), key = await encryptionKey(env);
  const bytes = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(supplierId) }, key, enc.encode(JSON.stringify(keys))));
  return btoa(String.fromCharCode(...iv)) + "." + btoa(String.fromCharCode(...bytes));
}
export async function openKeys(env: RosskoEnv, supplierId: string, cipher: string): Promise<RosskoKeys> {
  const key = await encryptionKey(env);
  try {
    const [iv, bytes] = cipher.split(".");
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: Uint8Array.from(atob(iv), c => c.charCodeAt(0)), additionalData: enc.encode(supplierId) }, key, Uint8Array.from(atob(bytes), c => c.charCodeAt(0)));
    const keys = JSON.parse(new TextDecoder().decode(plain));
    if (!/^[a-f0-9]{32}$/i.test(keys.key1) || !/^[a-f0-9]{32}$/i.test(keys.key2)) throw new Error(); return keys;
  } catch { throw new InputError("Не удалось прочитать сохранённые ключи. Введите оба ключа заново.", 503); }
}
