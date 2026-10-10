import { z } from "zod";
import { InputError, normalize } from "../lib/inventory-domain";
import { supplierRecordSchema } from "../lib/suppliers";
import { parseBackupManifest, verifyBackupPart } from "../lib/backup-integrity";
export const backupTables = ["settings", "customers", "suppliers", "imports", "products", "orders", "order_items", "vin_requests", "topups", "ledger", "stock_movements", "purchase_runs", "purchase_orders", "purchase_order_items", "purchase_receipts", "purchase_receipt_items"];
const identifier = z.string().min(1).max(80);
const timestamp = z.string().datetime();
const nonnegative = z.number().int().min(0).max(10000000);
const source = z.enum(["warehouse", "supplier"]);
const customerSchema = z.object({ id: identifier, email: z.string().email().max(254), name: z.string().max(200), role: z.enum(["admin", "customer"]), discount_bps: z.number().int().min(0).max(8000), markup_bps: z.number().int().min(0).max(100000).default(0), created_at: timestamp });
export const backupSchema = z.object({
  format: z.literal("inventory-atoll"), version: z.union([z.literal(1), z.literal(2), z.literal(3)]), exportedAt: timestamp,
  settings: z.array(z.object({ key: z.string().max(250), value: z.string().max(254) })).max(200),
  customers: z.array(customerSchema).max(2000),
  suppliers: z.array(supplierRecordSchema).max(2000).default([]),
  imports: z.array(z.object({ id: identifier, filename: z.string().max(180), file_key: z.string().nullable(), row_count: nonnegative, created_at: timestamp, source_name: z.string().min(1).max(120), source_type: source, lead_days: z.number().int().min(0).max(365).nullable(), supplier_id: identifier.nullable().default(null) })).max(500),
  products: z.array(z.object({ id: identifier, import_id: identifier, code: z.string().min(1).max(80), brand: z.string().max(100), name: z.string().min(1).max(400), search_text: z.string().max(1000), stock: nonnegative.nullable(), price_cents: z.number().int().min(1).max(1000000000), warehouse: z.string().max(120).default(""), bin: z.string().max(80).default(""), min_stock: nonnegative.default(0) })).max(30000),
  orders: z.array(z.object({ id: identifier, customer_id: identifier, idempotency_key: identifier, total_cents: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), status: z.enum(["new", "processing", "ready", "completed", "cancelled"]), comment: z.string().max(2000), created_at: timestamp, channel: z.enum(["online", "pos"]).default("online"), fiscal_status: z.string().max(40).default("not_sent") })).max(10000),
  order_items: z.array(z.object({ id: identifier, order_id: identifier, product_id: identifier, code: z.string().min(1).max(80), brand: z.string().max(100), name: z.string().min(1).max(400), quantity: z.number().int().positive().max(100000), unit_price_cents: z.number().int().positive().max(10000000000), source_name: z.string().max(120), source_type: source, lead_days: z.number().int().min(0).max(365).nullable() })).max(30000),
  vin_requests: z.array(z.object({ id: identifier, customer_id: identifier, vin: z.string().regex(/^[A-HJ-NPR-Z0-9]{17}$/), vehicle: z.string().max(200), details: z.string().max(2000), answer: z.string().max(4000), status: z.enum(["new", "answered"]), created_at: timestamp })).max(10000),
  topups: z.array(z.object({ id: identifier, customer_id: identifier, amount_cents: z.number().int().positive().max(100000000), reference: z.string().max(300), status: z.enum(["pending", "approved", "rejected"]), created_at: timestamp, approved_at: timestamp.nullable() })).max(10000),
  ledger: z.array(z.object({ id: identifier, customer_id: identifier, amount_cents: z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER), kind: z.enum(["topup", "order", "refund"]), reference_id: identifier, created_at: timestamp })).max(20000),
  stock_movements: z.array(z.object({ id: identifier, product_id: identifier, delta: z.number().int().min(-10000000).max(10000000).nullable(), kind: z.string().max(50), reference_id: identifier, created_at: timestamp })).max(30000),
  purchase_runs: z.array(z.object({ id: identifier, idempotency_key: identifier, created_by: identifier, created_at: timestamp })).max(10000).default([]),
  purchase_orders: z.array(z.object({ id: identifier, run_id: identifier, supplier_name: z.string().min(1).max(120), status: z.enum(["draft", "ordered", "partial", "received", "cancelled"]), total_cents: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), created_at: timestamp, ordered_at: timestamp.nullable() })).max(10000).default([]),
  purchase_order_items: z.array(z.object({ id: identifier, purchase_id: identifier, warehouse_product_id: identifier, supplier_product_id: identifier, code: z.string().min(1).max(80), brand: z.string().max(100), name: z.string().min(1).max(400), quantity: z.number().int().positive().max(100000), received_qty: z.number().int().nonnegative().max(100000), unit_cost_cents: z.number().int().positive().max(1000000000), lead_days: z.number().int().min(0).max(365).nullable() })).max(30000).default([]),
  purchase_receipts: z.array(z.object({ id: identifier, purchase_id: identifier, idempotency_key: identifier, created_by: identifier, created_at: timestamp })).max(10000).default([]),
  purchase_receipt_items: z.array(z.object({ id: identifier, receipt_id: identifier, purchase_item_id: identifier, quantity: z.number().int().positive().max(100000) })).max(30000).default([]),
});
export function validateBackup(input: unknown) {
  const parsed = backupSchema.safeParse(input);
  if (!parsed.success) throw new InputError("Некорректная копия: " + parsed.error.issues[0].path.join(".") + ".");
  const data = parsed.data;
  if (data.version === 3 && (!input || typeof input !== "object" || !("suppliers" in input))) throw new InputError("В копии отсутствует справочник поставщиков.");
  const tables = [data.customers, data.suppliers, data.imports, data.products, data.orders, data.order_items, data.vin_requests, data.topups, data.ledger, data.stock_movements, data.purchase_runs, data.purchase_orders, data.purchase_order_items, data.purchase_receipts, data.purchase_receipt_items];
  for (const rows of tables) if (new Set(rows.map(x => x.id)).size !== rows.length) throw new InputError("В копии есть повторяющиеся записи.");
  if (new Set(data.customers.map(x => x.email.toLowerCase())).size !== data.customers.length) throw new InputError("В копии есть повторяющиеся email.");
  if (new Set(data.suppliers.map(x => x.name_key)).size !== data.suppliers.length || data.suppliers.some(x => x.name_key !== normalize(x.name))) throw new InputError("В копии неверные или повторяющиеся названия поставщиков.");
  const suppliers = new Set(data.suppliers.map(x => x.id));
  if (data.imports.some(x => x.supplier_id !== null && (!suppliers.has(x.supplier_id) || x.source_type !== "supplier")) || data.version === 3 && data.imports.some(x => x.source_type === "supplier" && x.supplier_id === null)) throw new InputError("В копии нарушены связи прайсов с поставщиками.");
  const orderEmail = data.settings.find(x => x.key === "order_notification_email");
  if (orderEmail?.value && !z.string().email().max(254).safeParse(orderEmail.value).success) throw new InputError("В копии некорректный email для заказов.");
  const customers = new Set(data.customers.map(x => x.id)), imports = new Set(data.imports.map(x => x.id)), products = new Set(data.products.map(x => x.id)), orders = new Set(data.orders.map(x => x.id));
  if (data.products.some(x => !imports.has(x.import_id)) || [...data.orders, ...data.vin_requests, ...data.topups, ...data.ledger].some(x => !customers.has(x.customer_id)) || data.order_items.some(x => !products.has(x.product_id) || !orders.has(x.order_id)) || data.stock_movements.some(x => !products.has(x.product_id)) || data.settings.filter(x => x.key.startsWith("active_import:")).some(x => !imports.has(x.value))) throw new InputError("В копии нарушены связи между данными.");
  for (const order of data.orders) {
    const lines = data.order_items.filter(x => x.order_id === order.id);
    if (!lines.length || lines.reduce((s, x) => s + x.quantity * x.unit_price_cents, 0) !== order.total_cents) throw new InputError("В копии неверная сумма заказа " + order.id + ".");
  }
  const runs = new Set(data.purchase_runs.map(r => r.id)), purchases = new Set(data.purchase_orders.map(o => o.id));
  const purchaseItems = new Map(data.purchase_order_items.map(i => [i.id, i])), receipts = new Map(data.purchase_receipts.map(r => [r.id, r]));
  if (data.purchase_runs.some(r => !customers.has(r.created_by)) || data.purchase_orders.some(o => !runs.has(o.run_id)) || data.purchase_order_items.some(i => !purchases.has(i.purchase_id) || !products.has(i.warehouse_product_id) || !products.has(i.supplier_product_id) || i.received_qty > i.quantity) || data.purchase_receipts.some(r => !purchases.has(r.purchase_id) || !customers.has(r.created_by)) || data.purchase_receipt_items.some(i => !receipts.has(i.receipt_id) || !purchaseItems.has(i.purchase_item_id) || receipts.get(i.receipt_id)!.purchase_id !== purchaseItems.get(i.purchase_item_id)!.purchase_id)) throw new InputError("В копии нарушены связи закупок и приёмки.");
  for (const purchase of data.purchase_orders) {
    const lines = data.purchase_order_items.filter(i => i.purchase_id === purchase.id);
    if (!lines.length || lines.reduce((s, i) => s + i.quantity * i.unit_cost_cents, 0) !== purchase.total_cents || purchase.status === "received" && lines.some(i => i.received_qty !== i.quantity) || ["draft", "cancelled"].includes(purchase.status) && lines.some(i => i.received_qty > 0)) throw new InputError("В копии неверные суммы или статус закупки.");
  }
  for (const item of data.purchase_order_items) if (data.purchase_receipt_items.filter(i => i.purchase_item_id === item.id).reduce((s, i) => s + i.quantity, 0) !== item.received_qty) throw new InputError("В копии количество приёмки не совпадает с закупкой.");
  return data;
}
export async function restoreBackup(db: D1Database, bucket: R2Bucket, form: FormData, owner: { id: string; email: string }) {
  const raw = form.get("data");
  if (typeof raw !== "string" || new TextEncoder().encode(raw).byteLength > 16_000_000) throw new InputError("Резервная копия слишком большая или повреждена.");
  let input; try { input = JSON.parse(raw); } catch { throw new InputError("Не удалось прочитать резервную копию."); }
  const data = validateBackup(input);
  const manifestRaw = form.get("manifest");
  const manifest = typeof manifestRaw === "string" && manifestRaw.length < 200000 ? parseBackupManifest(manifestRaw) : null;
  if (data.version >= 2 && !manifest) throw new InputError("В копии отсутствует список контрольных сумм manifest.json.");
  if (manifest) await verifyBackupPart(manifest, "backup.json", new TextEncoder().encode(raw));
  const emptyCountSql = backupTables.filter(table => table !== "customers" && table !== "settings").map(table => "(SELECT COUNT(*) FROM " + table + ")").join("+") + "+(SELECT COUNT(*) FROM customers WHERE id<>?)+(SELECT COUNT(*) FROM settings WHERE key='restore_completed')";
  const existing = await db.prepare("SELECT " + emptyCountSql + " AS count").bind(owner.id).first<{ count: number }>();
  if (existing?.count) throw new InputError("Восстановление доступно только для пустой базы. Текущие данные не изменены.", 409);
  const ownerMatch = data.customers.find(x => x.email.toLowerCase() === owner.email.toLowerCase());
  const ids = new Map(data.customers.map(x => [x.id, x.id === ownerMatch?.id ? owner.id : x.id === owner.id ? crypto.randomUUID() : x.id]));
  const customerId = (v: string) => ids.get(v)!;
  const prefix = "restores/" + crypto.randomUUID() + "/";
  const files: string[] = [];
  const importRows = [];
  for (const item of data.imports) {
    const file = form.get("file:" + item.id);
    if (item.file_key && !(file instanceof File)) throw new InputError("В копии отсутствует исходный файл " + item.filename + ".");
    if (file instanceof File && file.size > 8_000_000) throw new InputError("Исходный прайс слишком большой.");
    if (manifest && file instanceof File) await verifyBackupPart(manifest, "files/" + item.id, new Uint8Array(await file.arrayBuffer()));
    importRows.push({ ...item, file_key: file instanceof File ? prefix + item.id : null });
  }
  const statements: D1PreparedStatement[] = [
    // Recheck emptiness in the transaction; NOT NULL rejects a concurrent write.
    db.prepare("INSERT INTO settings (key,value) SELECT 'restore_completed',CASE WHEN " + emptyCountSql + "=0 THEN ? ELSE NULL END").bind(owner.id, new Date().toISOString()),
  ];
  function addRows(table: string, columns: string[], rows: Record<string, unknown>[], upsert = "") {
    const sql = "INSERT INTO " + table + " (" + columns.join(",") + ") SELECT " + columns.map(column => "json_extract(value,'$." + column + "')").join(",") + " FROM json_each(?) WHERE true " + upsert;
    let parts: string[] = [], bytes = 2;
    const flush = () => { if (parts.length) statements.push(db.prepare(sql).bind("[" + parts.join(",") + "]")); parts = []; bytes = 2; };
    for (const row of rows) {
      const encoded = JSON.stringify(row), length = new TextEncoder().encode(encoded).byteLength + 1;
      if (bytes + length > 1_000_000) flush();
      parts.push(encoded); bytes += length;
    }
    flush();
  }
  if (ownerMatch) statements.push(db.prepare("UPDATE customers SET discount_bps=?,markup_bps=? WHERE id=?").bind(ownerMatch.discount_bps, ownerMatch.markup_bps, owner.id));
  addRows("customers", ["id", "email", "name", "role", "discount_bps", "markup_bps", "created_at"], data.customers.filter(row => row.id !== ownerMatch?.id).map(row => ({ ...row, id: customerId(row.id), email: row.email.toLowerCase(), role: "customer" })));
  addRows("suppliers", ["id", "name", "name_key", "connection_type", "lead_days", "contact_name", "phone", "email", "website", "api_url", "api_docs_url", "notes", "enabled", "revision", "created_at", "updated_at"], data.suppliers);
  addRows("imports", ["id", "filename", "file_key", "row_count", "created_at", "source_name", "source_type", "lead_days", "supplier_id"], importRows);
  addRows("products", ["id", "import_id", "code", "brand", "name", "search_text", "stock", "price_cents", "warehouse", "bin", "min_stock"], data.products);
  addRows("orders", ["id", "customer_id", "idempotency_key", "total_cents", "status", "comment", "created_at", "channel", "fiscal_status"], data.orders.map(row => ({ ...row, customer_id: customerId(row.customer_id) })));
  addRows("order_items", ["id", "order_id", "product_id", "code", "brand", "name", "quantity", "unit_price_cents", "source_name", "source_type", "lead_days"], data.order_items);
  addRows("vin_requests", ["id", "customer_id", "vin", "vehicle", "details", "answer", "status", "created_at"], data.vin_requests.map(row => ({ ...row, customer_id: customerId(row.customer_id) })));
  addRows("topups", ["id", "customer_id", "amount_cents", "reference", "status", "created_at", "approved_at"], data.topups.map(row => ({ ...row, customer_id: customerId(row.customer_id) })));
  addRows("ledger", ["id", "customer_id", "amount_cents", "kind", "reference_id", "created_at"], data.ledger.map(row => ({ ...row, customer_id: customerId(row.customer_id) })));
  addRows("stock_movements", ["id", "product_id", "delta", "kind", "reference_id", "created_at"], data.stock_movements);
  addRows("purchase_runs", ["id", "idempotency_key", "created_by", "created_at"], data.purchase_runs.map(row => ({ ...row, created_by: customerId(row.created_by) })));
  addRows("purchase_orders", ["id", "run_id", "supplier_name", "status", "total_cents", "created_at", "ordered_at"], data.purchase_orders);
  addRows("purchase_order_items", ["id", "purchase_id", "warehouse_product_id", "supplier_product_id", "code", "brand", "name", "quantity", "received_qty", "unit_cost_cents", "lead_days"], data.purchase_order_items);
  addRows("purchase_receipts", ["id", "purchase_id", "idempotency_key", "created_by", "created_at"], data.purchase_receipts.map(row => ({ ...row, created_by: customerId(row.created_by) })));
  addRows("purchase_receipt_items", ["id", "receipt_id", "purchase_item_id", "quantity"], data.purchase_receipt_items);
  addRows("settings", ["key", "value"], data.settings.filter(row => row.key.startsWith("active_import:") || row.key === "order_notification_email"), "ON CONFLICT(key) DO UPDATE SET value=excluded.value");
  try {
    for (const item of importRows) if (item.file_key) { const file = form.get("file:" + item.id) as File; await bucket.put(item.file_key, await file.arrayBuffer()); files.push(item.file_key); }
    await db.batch(statements);
  } catch (e) {
    await Promise.allSettled(files.map(key => bucket.delete(key)));
    console.error("Backup restore failed", e instanceof Error ? e.message : "unknown");
    throw new InputError("Восстановление не завершено. Данные базы не изменены.", 409);
  }
  return { products: data.products.length, orders: data.orders.length };
}
