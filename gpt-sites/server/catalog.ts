import { InputError, normalize, type PriceRow } from "../lib/inventory-domain";

type CatalogRow = PriceRow & { warehouse?: string; bin?: string; minStock?: number };
export type CatalogInput = {
  rows: CatalogRow[]; sourceName: string; sourceType: "warehouse" | "supplier";
  leadDays: number | null; stockMode: "physical" | "available";
  filename: string; content: ArrayBuffer; contentType: string;
};
type Existing = { id: string; code: string; brand: string; warehouse: string; bin: string; min_stock: number };

export async function replaceCatalog(db: D1Database, bucket: R2Bucket, input: CatalogInput) {
  const { rows, sourceName, sourceType, leadDays, stockMode } = input;
  const activeKey = "active_import:" + normalize(sourceType + ":" + sourceName);
  const oldImport = (await db.prepare("SELECT value FROM settings WHERE key=?").bind(activeKey).first<{ value: string }>())?.value ?? "";
  const previous = (await db.prepare("SELECT p.id,p.code,p.brand,p.warehouse,p.bin,p.min_stock FROM products p JOIN imports i ON i.id=p.import_id WHERE i.source_type=? AND i.source_name=? ORDER BY i.created_at DESC").bind(sourceType, sourceName).all<Existing>()).results;
  const known = new Map<string, Existing>();
  for (const item of previous) {
    const key = normalize(item.code) + "\u0000" + normalize(item.brand);
    if (!known.has(key)) known.set(key, item);
  }
  const prepared = rows.map(row => {
    const old = known.get(normalize(row.code) + "\u0000" + normalize(row.brand));
    return { ...row, id: old?.id ?? crypto.randomUUID(), searchText: normalize(row.code + " " + row.brand + " " + row.name),
      warehouse: row.warehouse ?? old?.warehouse ?? (sourceType === "warehouse" ? sourceName : ""),
      bin: row.bin ?? old?.bin ?? "", minStock: row.minStock ?? old?.min_stock ?? 0 };
  });
  const importId = crypto.randomUUID(), created = new Date().toISOString(), key = "imports/" + importId;
  const filename = input.filename.replace(/[\x00-\x1f/\\]/g, "_").slice(0, 180);
  const statements = [db.prepare("INSERT INTO imports (id,filename,file_key,row_count,created_at,source_name,source_type,lead_days) SELECT ?,?,?,?,?,?,?,? WHERE COALESCE((SELECT value FROM settings WHERE key=?),'')=?")
    .bind(importId, filename, key, rows.length, created, sourceName, sourceType, leadDays, activeKey, oldImport)];
  // JSON binds keep a 10,000-row price below the per-query parameter and
  // invocation query limits. The entire replacement is one D1 transaction.
  for (let offset = 0; offset < prepared.length; offset += 500) {
    statements.push(db.prepare(`INSERT INTO products (id,import_id,code,brand,name,search_text,stock,price_cents,warehouse,bin,min_stock)
      SELECT json_extract(r.value,'$.id'),?,json_extract(r.value,'$.code'),json_extract(r.value,'$.brand'),json_extract(r.value,'$.name'),json_extract(r.value,'$.searchText'),
        CASE WHEN json_extract(r.value,'$.stock') IS NULL THEN NULL ELSE json_extract(r.value,'$.stock') -
          CASE WHEN ?=1 THEN COALESCE((SELECT SUM(oi.quantity) FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE oi.product_id=json_extract(r.value,'$.id') AND o.status IN ('new','processing','ready')),0) ELSE 0 END END,
        json_extract(r.value,'$.priceCents'),json_extract(r.value,'$.warehouse'),json_extract(r.value,'$.bin'),json_extract(r.value,'$.minStock')
      FROM json_each(?) r WHERE true
      ON CONFLICT(id) DO UPDATE SET import_id=excluded.import_id,code=excluded.code,brand=excluded.brand,name=excluded.name,search_text=excluded.search_text,stock=excluded.stock,price_cents=excluded.price_cents,warehouse=excluded.warehouse,bin=excluded.bin,min_stock=excluded.min_stock`)
      .bind(importId, sourceType === "warehouse" && stockMode === "physical" ? 1 : 0, JSON.stringify(prepared.slice(offset, offset + 500))));
  }
  statements.push(db.prepare("INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(activeKey, importId));
  await bucket.put(key, input.content, { httpMetadata: { contentType: input.contentType } });
  try { await db.batch(statements); }
  catch (error) {
    await bucket.delete(key).catch(() => {});
    const reason = error instanceof Error ? error.message : "";
    if (stockMode === "physical" && reason.includes("stock_nonnegative")) throw new InputError("Остаток в файле меньше количества в открытых заказах. Проверьте резервы и прайс; прежний каталог сохранён.", 409);
    throw new InputError("Каталог изменился во время загрузки или прайс не прошёл проверку. Прежние данные сохранены; повторите загрузку.", 409);
  }
  return { count: rows.length, filename, productIds: prepared.map(row => row.id) };
}
