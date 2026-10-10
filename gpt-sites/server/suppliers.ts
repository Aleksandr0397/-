import { z } from "zod";
import { InputError, normalize } from "../lib/inventory-domain";
import { supplierInputSchema, supplierInput, type Supplier } from "../lib/suppliers";
const active = "SELECT value FROM settings WHERE key LIKE 'active_import:%'";
export const supplierVisible = (alias = "i") => `(${alias}.supplier_id IS NULL OR EXISTS (SELECT 1 FROM suppliers sv WHERE sv.id=${alias}.supplier_id AND sv.enabled=1))`;
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });

// Adopt existing supplier prices as records outside schema-only migrations.
// A stable supplier ID keeps price replacement safe after a name change.
export async function linkLegacySuppliers(db: D1Database) {
  const old = (await db.prepare("SELECT source_name,lead_days FROM imports WHERE source_type='supplier' AND supplier_id IS NULL ORDER BY created_at DESC").all<{ source_name: string; lead_days: number | null }>()).results;
  if (!old.length) return;
  const pointers = new Map((await db.prepare("SELECT key,value FROM settings WHERE key LIKE 'active_import:supplier:%'").all<{ key: string; value: string }>()).results.map(row => [row.key, row.value]));
  const unique = new Map<string, typeof old[number]>();
  for (const row of old) if (!unique.has(row.source_name)) unique.set(row.source_name, row);
  const timestamp = new Date().toISOString();
  const rows = JSON.stringify([...unique.values()].map(row => ({ id: crypto.randomUUID(), name: row.source_name.trim(), nameKey: normalize(row.source_name), leadDays: row.lead_days ?? 0, oldKey: "active_import:" + normalize("supplier:" + row.source_name), activeId: pointers.get("active_import:" + normalize("supplier:" + row.source_name)) ?? null })));
  await db.batch([
    db.prepare("INSERT INTO suppliers (id,name,name_key,lead_days,created_at,updated_at) SELECT json_extract(value,'$.id'),json_extract(value,'$.name'),json_extract(value,'$.nameKey'),json_extract(value,'$.leadDays'),?,? FROM json_each(?) WHERE true ON CONFLICT(name_key) DO NOTHING").bind(timestamp, timestamp, rows),
    db.prepare("UPDATE imports SET supplier_id=(SELECT s.id FROM suppliers s JOIN json_each(?) r ON s.name_key=json_extract(r.value,'$.nameKey') WHERE json_extract(r.value,'$.name')=trim(imports.source_name) LIMIT 1),source_name=(SELECT s.name FROM suppliers s JOIN json_each(?) r ON s.name_key=json_extract(r.value,'$.nameKey') WHERE json_extract(r.value,'$.name')=trim(imports.source_name) LIMIT 1) WHERE source_type='supplier' AND supplier_id IS NULL").bind(rows, rows),
    db.prepare("INSERT INTO settings (key,value) SELECT 'active_import:supplier:'||s.id,json_extract(r.value,'$.activeId') FROM json_each(?) r JOIN suppliers s ON s.name_key=json_extract(r.value,'$.nameKey') WHERE json_extract(r.value,'$.activeId') IS NOT NULL ON CONFLICT(key) DO NOTHING").bind(rows),
    db.prepare("DELETE FROM settings WHERE key IN (SELECT json_extract(value,'$.oldKey') FROM json_each(?)) AND key NOT IN (SELECT 'active_import:supplier:'||id FROM suppliers)").bind(rows),
  ]);
}
export async function supplierForPrice(db: D1Database, supplierId: unknown, legacyName: unknown) {
  await linkLegacySuppliers(db);
  const byId = typeof supplierId === "string" && supplierId;
  const supplier = await db.prepare("SELECT * FROM suppliers WHERE " + (byId ? "id=?" : "name_key=?")).bind(byId || normalize(typeof legacyName === "string" ? legacyName : "")).first<Supplier>();
  if (!supplier) throw new InputError("Сначала добавьте поставщика в разделе «Поставщики» и выберите его для загрузки прайса.");
  if (!supplier.enabled) throw new InputError("Поставщик отключён. Включите его перед загрузкой прайса.", 409);
  if (supplier.connection_type === "api") throw new InputError("Для этого поставщика выбран только API. Для загрузки файла выберите «Прайс» или «Прайс и API».", 409);
  return supplier;
}
export async function supplierApi(request: Request, db: D1Database) {
  const path = new URL(request.url).pathname.replace(/\/$/, "");
  if (path === "/api/suppliers" && request.method === "GET") {
    await linkLegacySuppliers(db);
    const rows = (await db.prepare(`SELECT s.*,(SELECT COUNT(*) FROM products p JOIN imports i ON i.id=p.import_id WHERE i.supplier_id=s.id AND i.id IN (${active})) AS product_count,(SELECT MAX(created_at) FROM imports WHERE supplier_id=s.id) AS last_import_at FROM suppliers s ORDER BY s.enabled DESC,s.name COLLATE NOCASE`).all<Supplier>()).results;
    return json({ suppliers: rows.map(s => ({ ...s, apiConnected: false })) });
  }
  if (request.method !== "POST" && request.method !== "PATCH") throw new InputError("Поставщик не найден.", 404);
  if (request.method === "POST" && path !== "/api/suppliers" || request.method === "PATCH" && !/^\/api\/suppliers\/[^/]+$/.test(path)) throw new InputError("Поставщик не найден.", 404);
  const raw = await request.text(); if (raw.length > 16000) throw new InputError("Карточка поставщика слишком большая.", 413);
  let input; try { input = JSON.parse(raw); } catch { throw new InputError("Не удалось прочитать карточку поставщика."); }
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new InputError("Некорректная карточка поставщика.");
  await linkLegacySuppliers(db);
  const supplierId = request.method === "POST" ? crypto.randomUUID() : path.split("/").pop()!;
  const existing = request.method === "PATCH" ? await db.prepare("SELECT * FROM suppliers WHERE id=?").bind(supplierId).first<Supplier>() : null;
  if (request.method === "PATCH" && !existing) throw new InputError("Поставщик не найден.", 404);
  const parsed = supplierInputSchema.safeParse(existing ? { ...supplierInput(existing), ...input } : input);
  if (!parsed.success) throw new InputError("Проверьте карточку: " + parsed.error.issues[0].message);
  const data = parsed.data, nameKey = normalize(data.name), timestamp = new Date().toISOString();
  if (!nameKey) throw new InputError("Укажите название поставщика.");
  const values = [data.name, nameKey, data.connectionType, data.leadDays, data.contactName, data.phone, data.email.toLowerCase(), data.website, data.apiUrl, data.apiDocsUrl, data.notes, data.enabled ? 1 : 0];
  try {
    if (request.method === "POST") {
      await db.prepare("INSERT INTO suppliers (id,name,name_key,connection_type,lead_days,contact_name,phone,email,website,api_url,api_docs_url,notes,enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(supplierId, ...values, timestamp, timestamp).run();
    } else {
      const revision = z.number().int().positive().safeParse(input.expectedRevision);
      if (!revision.success) throw new InputError("Обновите карточку поставщика перед сохранением.", 409);
      const result = await db.batch([
        db.prepare("UPDATE suppliers SET name=?,name_key=?,connection_type=?,lead_days=?,contact_name=?,phone=?,email=?,website=?,api_url=?,api_docs_url=?,notes=?,enabled=?,updated_at=?,revision=revision+1 WHERE id=? AND revision=?").bind(...values, timestamp, supplierId, revision.data),
        db.prepare("UPDATE imports SET source_name=(SELECT name FROM suppliers WHERE id=?) WHERE supplier_id=?").bind(supplierId, supplierId),
      ]);
      if (!result[0].meta.changes) throw new InputError("Карточка уже изменена или поставщик не найден. Обновите список и повторите сохранение.", 409);
    }
  } catch (error) {
    if (error instanceof InputError) throw error;
    if (error instanceof Error && error.message.includes("UNIQUE")) throw new InputError("Поставщик с таким названием уже существует.", 409);
    throw error;
  }
  const supplier = await db.prepare("SELECT * FROM suppliers WHERE id=?").bind(supplierId).first<Supplier>();
  return json({ supplier: { ...supplier, apiConnected: false } }, request.method === "POST" ? 201 : 200);
}
