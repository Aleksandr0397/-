import { InputError, text } from "../lib/inventory-domain";

export type IntegrationEnv = {
  MOYSKLAD_TOKEN?: string; MOYSKLAD_PRICE_TYPE_ID?: string; MOYSKLAD_PRICE_UNIT?: string;
  SABY_ACCESS_TOKEN?: string; SABY_POINT_ID?: string; SABY_PRICE_LIST_ID?: string; SABY_PRICE_UNIT?: string;
};
export type Provider = "moysklad" | "saby";
type Entry = Record<string, unknown>;
export type CataloguePreviewRow = { externalId: string; code: string; name: string; priceCents: number | null; externalStock: number | null };
const requirements = {
  moysklad: ["MOYSKLAD_TOKEN", "MOYSKLAD_PRICE_TYPE_ID", "MOYSKLAD_PRICE_UNIT"],
  saby: ["SABY_ACCESS_TOKEN", "SABY_POINT_ID", "SABY_PRICE_LIST_ID", "SABY_PRICE_UNIT"],
} as const;
export function integrationStatus(env: IntegrationEnv) {
  return (["moysklad", "saby"] as const).map(provider => {
    const missing = requirements[provider].filter(key => !env[key]);
    return { provider, title: provider === "moysklad" ? "МойСклад" : "Saby", configured: !missing.length, missing };
  });
}
const record = (value: unknown): Entry => value && typeof value === "object" && !Array.isArray(value) ? value as Entry : {};
function amount(value: unknown, unit: string): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  const result = Math.round(value * (unit === "rubles" ? 100 : 1));
  return Number.isSafeInteger(result) && result <= 1_000_000_000 ? result : null;
}
function quantity(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const result = typeof value === "string" ? Number(value.replace(",", ".")) : value;
  return typeof result === "number" && Number.isFinite(result) ? result : null;
}
export async function previewCatalogue(provider: Provider, env: IntegrationEnv, cursor = 0, transport: typeof fetch = fetch) {
  const settings = integrationStatus(env).find(row => row.provider === provider)!;
  if (!settings.configured) throw new InputError("Подключение требует настроек в GPT Sites: " + settings.missing.join(", ") + ".", 503);
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw new InputError("Некорректная страница каталога.");
  const unit = provider === "moysklad" ? env.MOYSKLAD_PRICE_UNIT! : env.SABY_PRICE_UNIT!;
  if (unit !== "kopecks" && unit !== "rubles") throw new InputError("В настройке единицы цены укажите kopecks или rubles после сверки с прайсом сервиса.", 503);
  const url = new URL(provider === "moysklad" ? "https://api.moysklad.ru/api/remap/1.2/entity/assortment" : "https://api.sbis.ru/retail/v2/nomenclature/list");
  const headers: Record<string, string> = { Accept: "application/json" };
  if (provider === "moysklad") {
    url.searchParams.set("limit", "25"); url.searchParams.set("offset", String(cursor)); url.searchParams.set("filter", "archived=false");
    headers.Authorization = "Bearer " + env.MOYSKLAD_TOKEN;
    headers["Accept-Encoding"] = "gzip";
  } else {
    for (const [key, value] of [["pointId", env.SABY_POINT_ID], ["priceListId", env.SABY_PRICE_LIST_ID]]) {
      if (!value || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) throw new InputError("Проверьте идентификаторы точки продаж и прайс-листа Saby.", 503);
      url.searchParams.set(key!, value);
    }
    url.searchParams.set("pageSize", "25"); url.searchParams.set("withBalance", "true"); url.searchParams.set("order", "after");
    if (cursor) url.searchParams.set("position", String(cursor));
    headers["X-SBISAccessToken"] = env.SABY_ACCESS_TOKEN!;
  }
  let response: Response;
  try { response = await transport(url.toString(), { method: "GET", headers, redirect: "error", signal: AbortSignal.timeout(12000) }); }
  catch { throw new InputError("Сервис не ответил за отведённое время. Каталог сайта не изменён.", 502); }
  if (!response.ok) throw new InputError("Сервис вернул HTTP " + response.status + ". Проверьте доступ приложения и настройки. Каталог сайта не изменён.", 502);
  let payload: Entry;
  try {
    const body = await response.text();
    if (new TextEncoder().encode(body).byteLength > 2_000_000) throw new Error();
    payload = record(JSON.parse(body));
  } catch { throw new InputError("Не удалось прочитать ответ сервиса. Каталог сайта не изменён.", 502); }
  const collection = provider === "moysklad" ? payload.rows : payload.nomenclatures;
  if (!Array.isArray(collection) || collection.length > 1000) throw new InputError("Формат ответа сервиса отличается от ожидаемого. Требуется сверка подключения; каталог сайта не изменён.", 502);
  const rows: CataloguePreviewRow[] = collection.map(record).filter(row => !row.isParent && !row.archived).map(row => {
    const prices = Array.isArray(row.salePrices) ? row.salePrices.map(record) : [];
    const selected = prices.find(price => {
      const type = record(price.priceType);
      const href = record(type.meta).href;
      return type.id === env.MOYSKLAD_PRICE_TYPE_ID || (typeof href === "string" && href.split("/").pop() === env.MOYSKLAD_PRICE_TYPE_ID);
    });
    return {
      externalId: String(provider === "moysklad" ? row.id ?? "" : row.externalId ?? row.id ?? "").slice(0, 100),
      code: text(String(row.article ?? row.code ?? row.nomNumber ?? ""), "Артикул сервиса", 80, false),
      name: text(String(row.name ?? ""), "Название сервиса", 400, false),
      priceCents: amount(provider === "moysklad" ? selected?.value : row.cost, unit),
      externalStock: quantity(provider === "moysklad" ? row.stock : row.balance),
    };
  });
  const lastPosition = Number(record(collection.at(-1)).hierarchicalId);
  const size = Number(record(payload.meta).size);
  const nextCursor = provider === "moysklad"
    ? (Number.isFinite(size) ? cursor + collection.length < size : collection.length === 25) ? cursor + collection.length : null
    : payload.outcome === true && Number.isSafeInteger(lastPosition) && lastPosition > cursor ? lastPosition : null;
  return { provider, checkedAt: new Date().toISOString(), rows, nextCursor, mode: "preview" as const };
}
