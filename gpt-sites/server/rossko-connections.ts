import { z } from "zod";
import { InputError, normalize } from "../lib/inventory-domain";
import { rosskoDeliveryLabel, rosskoDeliveryAddressId, rosskoDeliveryMethod, rosskoDeliveryWarning, rosskoAddressWarning, type RosskoConnection, type RosskoOptions } from "../lib/rossko";
import { rosskoDetails, rosskoSearch, rosskoDelivery, openKeys, sealKeys, type RosskoEnv, type RosskoKeys } from "./rossko";
export type ConnectionRow = { supplier_id: string; keys_cipher: string; delivery_id: string; address_id: number | null; options_json: string; verified_at: string | null; revision: number; last_request_at: number };
const key = z.string().trim().refine(s => !s || /^[a-f0-9]{32}$/i.test(s), "Ключ должен содержать 32 шестнадцатеричных символа.");
const inputSchema = z.object({ key1: key.optional(), key2: key.optional(), deliveryId: z.string().max(80).optional(), addressId: z.number().int().positive().nullable().optional() });
export async function secretBody(request: Request) {
  if (Number(request.headers.get("Content-Length") ?? 0) > 8000) throw new InputError("Настройки подключения слишком большие.", 413);
  const raw = await request.text(); if (raw.length > 8000) throw new InputError("Настройки подключения слишком большие.", 413);
  try { const body = JSON.parse(raw); if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error(); return body; } catch { throw new InputError("Не удалось прочитать настройки подключения."); }
}
function parseInput(input: unknown) { const p = inputSchema.safeParse(input ?? {}); if (!p.success) throw new InputError("Проверьте настройки ROSSKO: " + p.error.issues[0].message); return p.data; }
export async function connectionRow(db: D1Database, id: string) { return db.prepare("SELECT * FROM supplier_connections WHERE supplier_id=?").bind(id).first<ConnectionRow>(); }
export function connectionView(row: ConnectionRow | null): RosskoConnection {
  const options = row ? fixedRosskoDelivery(JSON.parse(row.options_json)) : { deliveries: [], addresses: [] };
  const selected = options.deliveries.find(d => d.id === row?.delivery_id);
  return { deliveryReady: !!selected, deliveryWarning: row && !selected ? rosskoDeliveryWarning : null, key1Saved: !!row?.keys_cipher, key2Saved: !!row?.keys_cipher, verifiedAt: row?.verified_at ?? null, deliveryId: selected?.id ?? "", addressId: options.addresses[0]?.id ?? null, options };
}
async function keysFor(env: RosskoEnv, id: string, row: ConnectionRow | null, input: ReturnType<typeof parseInput>): Promise<RosskoKeys> {
  const old = row && (!input.key1 || !input.key2) ? await openKeys(env, id, row.keys_cipher) : null;
  const keys = { key1: input.key1 || old?.key1 || "", key2: input.key2 || old?.key2 || "" };
  if (!keys.key1 || !keys.key2) throw new InputError("Введите оба ключа ROSSKO — Ключ 1 и Ключ 2."); return keys;
}
const canonical = (s: string) => s.normalize("NFKC").toLocaleLowerCase("ru").replace(/а/g, "a").replace(/[^а-яёa-z0-9]/g, "");
export function fixedRosskoDelivery(options: RosskoOptions): RosskoOptions {
  // Use only the address actually returned for this account. A missing
  // Delivery mapping does not prevent the owner's requested courier attempt.
  const couriers = options.deliveries.filter(d => !/самовывоз/i.test(d.name) && /курьер/i.test(d.name));
  const selected = couriers.find(d => canonical(d.name) === canonical(rosskoDeliveryMethod)) ?? (couriers.length === 1 ? couriers[0] : null);
  return { deliveries: selected ? [selected] : [], addresses: options.addresses.filter(a => a.id === rosskoDeliveryAddressId).slice(0, 1) };
}
function delivery(options: RosskoOptions, deliveryId?: string) {
  const fixed = fixedRosskoDelivery(options), d = fixed.deliveries[0];
  if (!d) throw new InputError(rosskoDeliveryWarning, 409);
  if (deliveryId && deliveryId !== d.id) throw new InputError("Для ROSSKO выбрана только «Курьерская доставка».", 409);
  return { deliveryId: d.id, addressId: fixed.addresses[0]?.id ?? null };
}
async function cabinetDelivery(db: D1Database, supplier: { id: string; revision: number }, row: ConnectionRow, keys: RosskoKeys) {
  let options = fixedRosskoDelivery(JSON.parse(row.options_json)), selected = delivery(options, row.delivery_id);
  if (selected.addressId && row.address_id === selected.addressId) return { ...selected, addressId: selected.addressId };
  // Connections saved without an address are refreshed on their first query.
  // Persist only routing data; never rewrite keys or a concurrent supplier edit.
  options = fixedRosskoDelivery(await rosskoDetails(keys)); selected = delivery(options, row.delivery_id);
  if (!selected.addressId) throw new InputError(rosskoAddressWarning, 409);
  const verifiedAt = new Date().toISOString(), optionsJson = JSON.stringify(options);
  const result = await db.prepare("UPDATE supplier_connections SET address_id=?,options_json=?,verified_at=?,revision=revision+1 WHERE supplier_id=? AND revision=? AND EXISTS(SELECT 1 FROM suppliers s WHERE s.id=supplier_connections.supplier_id AND s.revision=? AND s.enabled=1 AND s.api_provider='rossko' AND s.connection_type IN ('api','both'))").bind(selected.addressId, optionsJson, verifiedAt, supplier.id, row.revision, supplier.revision).run();
  if (!result.meta.changes) throw new InputError("Настройки поставщика изменились. Повторите запрос.", 409);
  row.address_id = selected.addressId; row.options_json = optionsJson; row.verified_at = verifiedAt; row.revision++;
  return { ...selected, addressId: selected.addressId };
}
export async function previewRosskoConnection(db: D1Database, env: RosskoEnv, input: unknown) {
  const data = input as { supplierId?: unknown; rossko?: unknown };
  let id = "new", row: ConnectionRow | null = null;
  if (data.supplierId !== undefined) {
    if (typeof data.supplierId !== "string" || data.supplierId.length > 80) throw new InputError("Поставщик не найден.", 404);
    id = data.supplierId;
    if (!await db.prepare("SELECT id FROM suppliers WHERE id=?").bind(id).first()) throw new InputError("Поставщик не найден.", 404);
    row = await connectionRow(db, id);
  }
  const keys = await keysFor(env, id, row, parseInput(data.rossko));
  const options = fixedRosskoDelivery(await rosskoDetails(keys));
  return { ok: true, options, deliveryReady: options.deliveries.length > 0, deliveryWarning: options.deliveries.length ? null : rosskoDeliveryWarning, ...(options.deliveries.length ? delivery(options) : { deliveryId: "", addressId: null }), checkedAt: new Date().toISOString() };
}
export async function prepareRosskoConnection(db: D1Database, env: RosskoEnv, id: string, raw: unknown) {
  const input = parseInput(raw), row = await connectionRow(db, id), keys = await keysFor(env, id, row, input);
  const stored: RosskoOptions | null = row ? JSON.parse(row.options_json) : null;
  const changed = !row || !!input.key1 || !!input.key2 || !row.verified_at || row.address_id !== rosskoDeliveryAddressId || !stored?.addresses.some(a => a.id === rosskoDeliveryAddressId) || !stored?.deliveries.some(d => d.id === row.delivery_id && /курьер/i.test(d.name) && !/самовывоз/i.test(d.name)) || !!input.deliveryId && input.deliveryId !== row.delivery_id;
  const options: RosskoOptions = fixedRosskoDelivery(changed ? await rosskoDetails(keys) : stored!);
  const selected = options.deliveries.length ? delivery(options, input.deliveryId) : { deliveryId: "", addressId: null };
  return { cipher: changed ? await sealKeys(env, id, keys) : row.keys_cipher, options: JSON.stringify(options), verifiedAt: changed ? new Date().toISOString() : row.verified_at!, ...selected };
}
export function connectionStatement(db: D1Database, id: string, c: Awaited<ReturnType<typeof prepareRosskoConnection>>) {
  // Immediately follows the supplier CAS write in the same D1 batch. A stale
  // supplier form must never change credentials, even if its revision matches
  // another writer's new revision.
  return db.prepare("INSERT INTO supplier_connections (supplier_id,keys_cipher,delivery_id,address_id,options_json,verified_at) SELECT ?,?,?,?,?,? WHERE changes()=1 ON CONFLICT(supplier_id) DO UPDATE SET keys_cipher=excluded.keys_cipher,delivery_id=excluded.delivery_id,address_id=excluded.address_id,options_json=excluded.options_json,verified_at=excluded.verified_at,revision=supplier_connections.revision+1").bind(id, c.cipher, c.deliveryId, c.addressId, c.options, c.verifiedAt);
}
export async function availableRossko(db: D1Database) {
  return (await db.prepare("SELECT s.id,s.name,c.delivery_id FROM suppliers s JOIN supplier_connections c ON c.supplier_id=s.id WHERE s.enabled=1 AND s.connection_type IN ('api','both') AND s.api_provider='rossko' AND c.verified_at IS NOT NULL ORDER BY s.name").all<{ id: string; name: string; delivery_id: string }>()).results;
}
export async function searchRosskoSupplier(db: D1Database, env: RosskoEnv, input: unknown) {
  const p = z.object({ supplierId: z.string().min(1).max(80), query: z.string().trim().min(2).max(160) }).safeParse(input);
  if (!p.success) throw new InputError("Укажите поставщика и артикул (от 2 до 160 символов).");
  const supplier = await db.prepare("SELECT id,name,enabled,connection_type,api_provider,revision FROM suppliers WHERE id=?").bind(p.data.supplierId).first<{ id: string; name: string; enabled: number; connection_type: string; api_provider: string; revision: number }>();
  const row = supplier ? await connectionRow(db, supplier.id) : null;
  if (!supplier?.enabled || supplier.connection_type === "price" || supplier.api_provider !== "rossko" || !row?.verified_at) throw new InputError("Подключение ROSSKO недоступно. Проверьте карточку поставщика.", 409);
  if (!row.delivery_id) throw new InputError(rosskoDeliveryWarning, 409);
  const keys = await openKeys(env, supplier.id, row.keys_cipher), time = Date.now();
  const acquired = await db.prepare("UPDATE supplier_connections SET last_request_at=? WHERE supplier_id=? AND revision=? AND last_request_at<=?").bind(time, supplier.id, row.revision, time - 3000).run();
  if (!acquired.meta.changes) throw new InputError("Подождите 3 секунды перед следующим запросом ROSSKO.", 429);
  const selected = await cabinetDelivery(db, supplier, row, keys);
  const offers = await rosskoSearch(keys, { query: p.data.query, ...selected });
  const current = await db.prepare("SELECT s.revision AS supplier_revision,c.revision AS connection_revision,s.enabled,s.api_provider,s.connection_type FROM suppliers s JOIN supplier_connections c ON c.supplier_id=s.id WHERE s.id=?").bind(supplier.id).first<{ supplier_revision: number; connection_revision: number; enabled: number; api_provider: string; connection_type: string }>();
  if (!current?.enabled || current.api_provider !== "rossko" || current.connection_type === "price" || current.supplier_revision !== supplier.revision || current.connection_revision !== row.revision) throw new InputError("Настройки поставщика изменились. Повторите поиск.", 409);
  return { offers, supplierName: supplier.name, checkedAt: new Date().toISOString(), query: p.data.query };
}
export async function deliveryRosskoSupplier(db: D1Database, env: RosskoEnv, input: unknown) {
  const p = z.object({ supplierId: z.string().min(1).max(80), date: z.string().regex(/^20\d{2}-\d{2}-\d{2}$/) }).safeParse(input);
  if (!p.success || !Number.isFinite(Date.parse(p.success ? p.data.date : "")) || new Date(p.data.date + "T12:00:00Z").toISOString().slice(0, 10) !== p.data.date) throw new InputError("Укажите корректную дату доставки.");
  const supplier = await db.prepare("SELECT id,revision FROM suppliers WHERE id=? AND enabled=1 AND connection_type IN ('api','both') AND api_provider='rossko'").bind(p.data.supplierId).first<{ id: string; revision: number }>();
  const row = supplier ? await connectionRow(db, supplier.id) : null;
  if (!supplier || !row?.verified_at) throw new InputError("Подключение ROSSKO недоступно.", 409);
  const time = Date.now();
  const acquired = await db.prepare("UPDATE supplier_connections SET last_request_at=? WHERE supplier_id=? AND revision=? AND last_request_at<=?").bind(time, supplier.id, row.revision, time - 3000).run();
  if (!acquired.meta.changes) throw new InputError("Подождите 3 секунды перед следующим запросом ROSSKO.", 429);
  const keys = await openKeys(env, supplier.id, row.keys_cipher), selected = await cabinetDelivery(db, supplier, row, keys);
  const waves = await rosskoDelivery(keys, p.data.date, selected.deliveryId, selected.addressId);
  const current = await db.prepare("SELECT s.revision AS supplier_revision,c.revision AS connection_revision FROM suppliers s JOIN supplier_connections c ON c.supplier_id=s.id WHERE s.id=? AND s.enabled=1 AND s.connection_type IN ('api','both') AND s.api_provider='rossko'").bind(supplier.id).first<{ supplier_revision: number; connection_revision: number }>();
  if (!current || current.supplier_revision !== supplier.revision || current.connection_revision !== row.revision) throw new InputError("Настройки поставщика изменились. Повторите запрос.", 409);
  return { waves, date: p.data.date, address: rosskoDeliveryLabel, checkedAt: new Date().toISOString() };
}
export async function bootstrapRossko(request: Request, db: D1Database, env: RosskoEnv) {
  // This narrow installation endpoint is for the owner-authorized deployment,
  // not visitor authentication. It accepts only server bootstrap keys, never
  // arbitrary suppliers or orders. It never replaces existing credentials.
  // A separate setup secret can be renewed without changing the encryption
  // key needed to read saved supplier credentials.
  const timestamp = request.headers.get("x-rossko-setup-time") ?? "", signature = request.headers.get("x-rossko-setup-signature") ?? "";
  const setupKey = env.ROSSKO_SETUP_KEY ?? env.SUPPLIER_CREDENTIALS_KEY;
  if (!/^[a-f0-9]{64}$/i.test(setupKey ?? "") || !/^\d{13}$/.test(timestamp) || Math.abs(Date.now() - Number(timestamp)) > 60000 || !/^[a-f0-9]{64}$/i.test(signature)) throw new InputError("Доступ запрещён.", 403);
  const raw = await request.text(); if (raw.length > 1000) throw new InputError("Доступ запрещён.", 403);
  const hmac = await crypto.subtle.importKey("raw", Uint8Array.from(setupKey!.match(/../g)!, x => parseInt(x, 16)), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const valid = await crypto.subtle.verify("HMAC", hmac, Uint8Array.from(signature.match(/../g)!, x => parseInt(x, 16)), new TextEncoder().encode("POST\n/api/integrations/rossko/bootstrap\n" + timestamp + "\n" + raw));
  if (!valid) throw new InputError("Доступ запрещён.", 403);
  let input: { action?: "courier" };
  try { input = z.object({ action: z.literal("courier").optional() }).strict().parse(JSON.parse(raw)); } catch { throw new InputError("Недопустимое действие подключения."); }
  const keys = { key1: env.ROSSKO_KEY1 ?? "", key2: env.ROSSKO_KEY2 ?? "" }; parseInput(keys);
  if (!keys.key1 || !keys.key2) throw new InputError("Начальные ключи ROSSKO не настроены.", 503);
  let supplier = await db.prepare("SELECT id,revision,api_provider FROM suppliers WHERE name_key=?").bind(normalize("ROSSKO")).first<{ id: string; revision: number; api_provider: string }>();
  const id = supplier?.id ?? crypto.randomUUID(), old = supplier ? await connectionRow(db, id) : null;
  if (!old) {
    const c = await prepareRosskoConnection(db, env, id, keys), timestamp = new Date().toISOString();
    const write = supplier ? db.prepare("UPDATE suppliers SET api_provider='rossko',connection_type=CASE WHEN connection_type='price' THEN 'both' ELSE connection_type END,revision=revision+1,updated_at=? WHERE id=? AND revision=?").bind(timestamp, id, supplier.revision) : db.prepare("INSERT INTO suppliers (id,name,name_key,connection_type,api_provider,website,api_url,api_docs_url,created_at,updated_at) VALUES (?,'ROSSKO',?,'api','rossko','https://rossko.ru','https://api.rossko.ru/service/v2.1','https://api.rossko.ru',?,?)").bind(id, normalize("ROSSKO"), timestamp, timestamp);
    const result = await db.batch([write, connectionStatement(db, id, c)]);
    if (!result[0].meta.changes) throw new InputError("Карточка ROSSKO изменилась. Повторите подключение.", 409);
  } else if (input.action === "courier") {
    if (supplier?.api_provider !== "rossko") throw new InputError("Карточка ROSSKO изменилась. Проверьте её вручную.", 409);
    const options = fixedRosskoDelivery(await rosskoDetails(await openKeys(env, id, old.keys_cipher)));
    const selected = options.deliveries.length ? delivery(options) : { deliveryId: "", addressId: null };
    const verifiedAt = new Date().toISOString();
    const result = await db.batch([
      db.prepare("UPDATE suppliers SET revision=revision+1,updated_at=? WHERE id=? AND revision=? AND api_provider='rossko' AND EXISTS(SELECT 1 FROM supplier_connections c WHERE c.supplier_id=suppliers.id AND c.revision=?)").bind(verifiedAt, id, supplier.revision, old.revision),
      connectionStatement(db, id, { cipher: old.keys_cipher, options: JSON.stringify(options), verifiedAt, ...selected }),
    ]);
    if (!result[0].meta.changes) throw new InputError("Карточка ROSSKO изменилась. Повторите подключение.", 409);
  }
  const row = await connectionRow(db, id); if (!row) throw new InputError("Подключение не сохранено.", 503);
  let search: { ok: boolean; offerCount?: number; reason?: string } = { ok: false, reason: "Не выбран способ доставки" };
  if (row.delivery_id) { try { const live = await searchRosskoSupplier(db, env, { supplierId: id, query: "333114" }); search = { ok: true, offerCount: live.offers.length }; } catch (e) { search = { ok: false, reason: e instanceof InputError ? e.message : "Поиск недоступен" }; } }
  return { ok: true, supplierId: id, keysVerified: !!row.verified_at, deliveryReady: !!row.delivery_id, deliveryId: row.delivery_id, addressId: row.address_id, deliveryMethod: row.delivery_id ? rosskoDeliveryMethod : null, deliveryWarning: row.delivery_id ? null : rosskoDeliveryWarning, verifiedAt: row.verified_at, deliveryOptionCount: (JSON.parse(row.options_json) as RosskoOptions).deliveries.length, search };
}
