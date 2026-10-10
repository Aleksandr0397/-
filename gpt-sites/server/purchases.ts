import { InputError, normalize, positiveInt, text } from "../lib/inventory-domain";

const active = "SELECT value FROM settings WHERE key LIKE 'active_import:%'";
const joinedProducts = "SELECT p.*,i.source_name,i.source_type,i.lead_days FROM products p JOIN imports i ON i.id=p.import_id";
const incoming = (alias: string) => `(SELECT COALESCE(SUM(pi.quantity-pi.received_qty),0) FROM purchase_order_items pi JOIN purchase_orders po ON po.id=pi.purchase_id WHERE pi.warehouse_product_id=${alias}.id AND po.status IN ('draft','ordered','partial'))`;
const plannedSupply = (alias: string) => `(SELECT COALESCE(SUM(pi.quantity-pi.received_qty),0) FROM purchase_order_items pi JOIN purchase_orders po ON po.id=pi.purchase_id WHERE pi.supplier_product_id=${alias}.id AND po.status IN ('draft','ordered','partial'))`;
type ProductRow = { id: string; import_id: string; code: string; brand: string; name: string; stock: number | null; price_cents: number; min_stock: number; source_name: string; source_type: string; lead_days: number | null; warehouse: string; bin: string };
type PurchaseRow = { id: string; status: string; supplier_name: string; total_cents: number; created_at: string; ordered_at: string | null };
type ItemRow = { id: string; purchase_id: string; warehouse_product_id: string; supplier_product_id: string; code: string; brand: string; name: string; quantity: number; received_qty: number; unit_cost_cents: number; lead_days: number | null };
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
async function all<T>(db: D1Database, sql: string, ...args: (string | number | null)[]) { return (await db.prepare(sql).bind(...args).all<T>()).results; }
async function body(request: Request) {
  const raw = await request.text();
  if (raw.length > 160000) throw new InputError("В документе слишком много данных.", 413);
  try { const value = JSON.parse(raw); if (!value || typeof value !== "object") throw new Error(); return value; }
  catch { throw new InputError("Не удалось прочитать документ закупки."); }
}
async function ordersForRun(db: D1Database, runId: string) { return all<PurchaseRow>(db, "SELECT * FROM purchase_orders WHERE run_id=? ORDER BY supplier_name", runId); }

export async function purchasingNeeds(db: D1Database) {
  const warehouse = await all<ProductRow & { incoming_qty: number }>(db, joinedProducts.replace("p.*,", "p.*," + incoming("p") + " AS incoming_qty,") + " WHERE p.import_id IN (" + active + ") AND i.source_type='warehouse' AND p.stock IS NOT NULL AND p.stock<p.min_stock ORDER BY p.code,p.id LIMIT 500");
  const suppliers = await all<ProductRow & { planned_qty: number }>(db, joinedProducts.replace("p.*,", "p.*," + plannedSupply("p") + " AS planned_qty,") + " WHERE p.import_id IN (" + active + ") AND i.source_type='supplier' AND (p.stock IS NULL OR p.stock>0)");
  return warehouse.map(product => {
    const quantity = Math.max(0, product.min_stock - (product.stock ?? 0) - product.incoming_qty);
    const offers = suppliers.filter(s => normalize(s.code) === normalize(product.code) && normalize(s.brand) === normalize(product.brand))
      .sort((a, b) => a.price_cents - b.price_cents || (a.lead_days ?? 366) - (b.lead_days ?? 366));
    return { product, quantity, incomingQty: product.incoming_qty, offers: offers.slice(0, 5), recommendedId: offers.find(s => s.stock !== null && s.stock - s.planned_qty >= quantity)?.id ?? null };
  });
}

export async function purchaseApi(request: Request, db: D1Database, customerId: string): Promise<Response> {
  const path = new URL(request.url).pathname.replace(/\/$/, ""), method = request.method;
  if (path === "/api/purchase-orders" && method === "GET") {
    const orders = await all<PurchaseRow>(db, "SELECT * FROM purchase_orders ORDER BY created_at DESC,id DESC LIMIT 150");
    const items = await all<ItemRow & { warehouse: string; bin: string }>(db, "SELECT pi.*,p.warehouse,p.bin FROM purchase_order_items pi JOIN products p ON p.id=pi.warehouse_product_id WHERE pi.purchase_id IN (SELECT value FROM json_each(?)) ORDER BY pi.code,pi.id", JSON.stringify(orders.map(o => o.id)));
    return json({ orders: orders.map(order => ({ ...order, items: items.filter(i => i.purchase_id === order.id) })), automaticSendingConnected: false });
  }
  if (path === "/api/purchase-orders" && method === "POST") {
    const input = await body(request), key = text(input.idempotencyKey, "Ключ закупки", 80);
    const previous = await db.prepare("SELECT id FROM purchase_runs WHERE idempotency_key=?").bind(key).first<{ id: string }>();
    if (previous) return json({ orders: await ordersForRun(db, previous.id), repeated: true });
    if (!Array.isArray(input.items) || !input.items.length || input.items.length > 100) throw new InputError("Выберите от 1 до 100 позиций закупки.");
    if (input.items.some((item: unknown) => !item || typeof item !== "object")) throw new InputError("Некорректная строка закупки.");
    const requested = input.items.map((item: { warehouseProductId: unknown; supplierProductId: unknown; quantity: unknown }) => ({
      warehouseProductId: text(item.warehouseProductId, "Товар склада", 80), supplierProductId: text(item.supplierProductId, "Предложение поставщика", 80), quantity: positiveInt(item.quantity, "Количество", 100000),
    }));
    if (new Set(requested.map((r: { warehouseProductId: string }) => r.warehouseProductId)).size !== requested.length) throw new InputError("Один складской товар нельзя повторять в закупке.");
    const ids = [...new Set<string>(requested.flatMap((r: { warehouseProductId: string; supplierProductId: string }) => [r.warehouseProductId, r.supplierProductId]))];
    const products = await all<ProductRow & { incoming_qty: number; planned_qty: number }>(db, joinedProducts.replace("p.*,", "p.*," + incoming("p") + " AS incoming_qty," + plannedSupply("p") + " AS planned_qty,") + " WHERE p.id IN (SELECT value FROM json_each(?)) AND p.import_id IN (" + active + ")", JSON.stringify(ids));
    const byId = new Map(products.map(p => [p.id, p]));
    const lines = requested.map((r: { warehouseProductId: string; supplierProductId: string; quantity: number }) => {
      const target = byId.get(r.warehouseProductId), supplier = byId.get(r.supplierProductId);
      if (!target || target.source_type !== "warehouse" || target.stock === null || !supplier || supplier.source_type !== "supplier") throw new InputError("Обновите прайсы и выберите складской товар и предложение поставщика.", 409);
      if (normalize(target.code) !== normalize(supplier.code) || normalize(target.brand) !== normalize(supplier.brand)) throw new InputError("Артикул и бренд поставщика должны совпадать со складским товаром.");
      if (r.quantity > target.min_stock - target.stock - target.incoming_qty) throw new InputError("Потребность уже покрыта остатком или другой закупкой. Обновите список.", 409);
      return { id: crypto.randomUUID(), ...r, target, supplier, receivedQty: 0 };
    });
    for (const supplierId of new Set(lines.map((l: { supplierProductId: string }) => l.supplierProductId))) {
      const related = lines.filter((l: { supplierProductId: string }) => l.supplierProductId === supplierId), supplier = related[0].supplier;
      if (supplier.stock !== null && related.reduce((s: number, l: { quantity: number }) => s + l.quantity, 0) + supplier.planned_qty > supplier.stock) throw new InputError("Поставщик не покрывает выбранное количество. Выберите другое предложение.", 409);
    }
    const runId = crypto.randomUUID(), createdAt = new Date().toISOString();
    const supplierNames = [...new Set<string>(lines.map((l: { supplier: ProductRow }) => l.supplier.source_name))];
    const orders = supplierNames.map(supplierName => ({ id: crypto.randomUUID(), supplierName, total: lines.filter((l: { supplier: ProductRow }) => l.supplier.source_name === supplierName).reduce((sum: number, l: { quantity: number; supplier: ProductRow }) => sum + l.quantity * l.supplier.price_cents, 0) }));
    for (const order of orders) positiveInt(order.total, "Сумма закупки", Number.MAX_SAFE_INTEGER);
    const payload = JSON.stringify(lines.map((l: { supplier: ProductRow & { planned_qty: number }; target: ProductRow & { incoming_qty: number }; [key: string]: unknown }) => ({ ...l, purchaseId: orders.find(o => o.supplierName === l.supplier.source_name)!.id })));
    const valid = `SELECT COUNT(*) FROM json_each(?) r JOIN products w ON w.id=json_extract(r.value,'$.warehouseProductId') JOIN products s ON s.id=json_extract(r.value,'$.supplierProductId')
      WHERE w.import_id=json_extract(r.value,'$.target.import_id') AND s.import_id=json_extract(r.value,'$.supplier.import_id') AND w.import_id IN (${active}) AND s.import_id IN (${active})
      AND w.code=json_extract(r.value,'$.target.code') AND w.brand=json_extract(r.value,'$.target.brand') AND s.code=json_extract(r.value,'$.supplier.code') AND s.brand=json_extract(r.value,'$.supplier.brand')
      AND w.stock=json_extract(r.value,'$.target.stock') AND w.min_stock=json_extract(r.value,'$.target.min_stock') AND ${incoming("w")}=json_extract(r.value,'$.target.incoming_qty')
      AND s.price_cents=json_extract(r.value,'$.supplier.price_cents') AND s.stock IS json_extract(r.value,'$.supplier.stock') AND ${plannedSupply("s")}=json_extract(r.value,'$.supplier.planned_qty')`;
    try {
      await db.batch([
        db.prepare("INSERT INTO purchase_runs (id,idempotency_key,created_by,created_at) SELECT ?,?,CASE WHEN (" + valid + ")=? THEN ? ELSE NULL END,?").bind(runId, key, payload, lines.length, customerId, createdAt),
        db.prepare("INSERT INTO purchase_orders (id,run_id,supplier_name,status,total_cents,created_at,ordered_at) SELECT json_extract(value,'$.id'),?,json_extract(value,'$.supplierName'),'draft',json_extract(value,'$.total'),?,NULL FROM json_each(?)").bind(runId, createdAt, JSON.stringify(orders)),
        db.prepare("INSERT INTO purchase_order_items (id,purchase_id,warehouse_product_id,supplier_product_id,code,brand,name,quantity,received_qty,unit_cost_cents,lead_days) SELECT json_extract(value,'$.id'),json_extract(value,'$.purchaseId'),json_extract(value,'$.warehouseProductId'),json_extract(value,'$.supplierProductId'),json_extract(value,'$.target.code'),json_extract(value,'$.target.brand'),json_extract(value,'$.target.name'),json_extract(value,'$.quantity'),0,json_extract(value,'$.supplier.price_cents'),json_extract(value,'$.supplier.lead_days') FROM json_each(?)").bind(payload),
      ]);
    } catch {
      const repeated = await db.prepare("SELECT id FROM purchase_runs WHERE idempotency_key=?").bind(key).first<{ id: string }>();
      if (repeated) return json({ orders: await ordersForRun(db, repeated.id), repeated: true });
      throw new InputError("Остатки, цены или потребность изменились. Обновите список закупки.", 409);
    }
    return json({ orders: await ordersForRun(db, runId) }, 201);
  }
  if (/^\/api\/purchase-orders\/[^/]+$/.test(path) && method === "PATCH") {
    const orderId = path.split("/").pop()!, data = await body(request);
    const order = await db.prepare("SELECT * FROM purchase_orders WHERE id=?").bind(orderId).first<PurchaseRow>();
    if (!order) throw new InputError("Закупка не найдена.", 404);
    if (data.status === order.status) return json({ ok: true, repeated: true });
    if (data.status === "ordered" && order.status === "draft") {
      await db.prepare("UPDATE purchase_orders SET status='ordered',ordered_at=? WHERE id=? AND status='draft'").bind(new Date().toISOString(), orderId).run();
    } else if (data.status === "cancelled" && ["draft", "ordered"].includes(order.status)) {
      await db.prepare("UPDATE purchase_orders SET status='cancelled' WHERE id=? AND status IN ('draft','ordered') AND NOT EXISTS (SELECT 1 FROM purchase_order_items WHERE purchase_id=? AND received_qty>0)").bind(orderId, orderId).run();
    } else throw new InputError("Принятую или частично принятую закупку нельзя отменить. Черновик можно отметить заказанным.", 409);
    const current = await db.prepare("SELECT status FROM purchase_orders WHERE id=?").bind(orderId).first<{ status: string }>();
    if (current?.status !== data.status) throw new InputError("Закупка изменилась во время операции. Обновите документы.", 409);
    return json({ ok: true });
  }
  if (/^\/api\/purchase-orders\/[^/]+\/receive$/.test(path) && method === "POST") {
    const orderId = path.split("/")[3], input = await body(request), key = text(input.idempotencyKey, "Ключ приёмки", 80);
    const previous = await db.prepare("SELECT id,purchase_id FROM purchase_receipts WHERE idempotency_key=?").bind(key).first<{ id: string; purchase_id: string }>();
    if (previous) { if (previous.purchase_id !== orderId) throw new InputError("Этот ключ относится к другой закупке.", 409); return json({ id: previous.id, repeated: true }); }
    if (!Array.isArray(input.items) || !input.items.length || input.items.length > 100) throw new InputError("Укажите от 1 до 100 строк приёмки.");
    if (input.items.some((item: unknown) => !item || typeof item !== "object")) throw new InputError("Некорректная строка приёмки.");
    const requested = input.items.map((item: { itemId: unknown; quantity: unknown }) => ({ itemId: text(item.itemId, "Строка закупки", 80), quantity: positiveInt(item.quantity, "Принято", 100000) }));
    if (new Set(requested.map((r: { itemId: string }) => r.itemId)).size !== requested.length) throw new InputError("Строка закупки повторяется.");
    const order = await db.prepare("SELECT status FROM purchase_orders WHERE id=?").bind(orderId).first<{ status: string }>();
    if (!order || !["ordered", "partial"].includes(order.status)) throw new InputError("Приёмка доступна для заказанных закупок.", 409);
    const items = await all<ItemRow>(db, "SELECT * FROM purchase_order_items WHERE purchase_id=?", orderId);
    const lines = requested.map((r: { itemId: string; quantity: number }) => {
      const line = items.find(i => i.id === r.itemId);
      if (!line || r.quantity > line.quantity - line.received_qty) throw new InputError("Количество приёмки превышает оставшееся в закупке.", 409);
      return { ...r, warehouseProductId: line.warehouse_product_id, previousQty: line.received_qty, receiptLineId: crypto.randomUUID(), movementId: crypto.randomUUID() };
    });
    const receiptId = crypto.randomUUID(), createdAt = new Date().toISOString(), payload = JSON.stringify(lines);
    const valid = `SELECT COUNT(*) FROM json_each(?) r JOIN purchase_order_items pi ON pi.id=json_extract(r.value,'$.itemId') JOIN products p ON p.id=pi.warehouse_product_id JOIN imports i ON i.id=p.import_id
      WHERE pi.purchase_id=? AND pi.received_qty=json_extract(r.value,'$.previousQty') AND pi.received_qty+json_extract(r.value,'$.quantity')<=pi.quantity
      AND p.import_id IN (${active}) AND i.source_type='warehouse' AND p.stock IS NOT NULL AND p.stock+json_extract(r.value,'$.quantity')<=10000000`;
    try {
      await db.batch([
        db.prepare("INSERT INTO purchase_receipts (id,purchase_id,idempotency_key,created_by,created_at) SELECT ?,?,?,CASE WHEN EXISTS (SELECT 1 FROM purchase_orders WHERE id=? AND status IN ('ordered','partial')) AND (" + valid + ")=? THEN ? ELSE NULL END,?").bind(receiptId, orderId, key, orderId, payload, orderId, lines.length, customerId, createdAt),
        db.prepare("INSERT INTO purchase_receipt_items (id,receipt_id,purchase_item_id,quantity) SELECT json_extract(value,'$.receiptLineId'),?,json_extract(value,'$.itemId'),json_extract(value,'$.quantity') FROM json_each(?)").bind(receiptId, payload),
        db.prepare("UPDATE purchase_order_items SET received_qty=received_qty+(SELECT json_extract(value,'$.quantity') FROM json_each(?) WHERE json_extract(value,'$.itemId')=purchase_order_items.id) WHERE id IN (SELECT json_extract(value,'$.itemId') FROM json_each(?))").bind(payload, payload),
        db.prepare("UPDATE products SET stock=stock+(SELECT SUM(json_extract(value,'$.quantity')) FROM json_each(?) WHERE json_extract(value,'$.warehouseProductId')=products.id) WHERE id IN (SELECT json_extract(value,'$.warehouseProductId') FROM json_each(?))").bind(payload, payload),
        db.prepare("INSERT INTO stock_movements (id,product_id,delta,kind,reference_id,created_at) SELECT json_extract(value,'$.movementId'),json_extract(value,'$.warehouseProductId'),json_extract(value,'$.quantity'),'purchase_receipt',?,? FROM json_each(?)").bind(receiptId, createdAt, payload),
        db.prepare("UPDATE purchase_orders SET status=CASE WHEN EXISTS (SELECT 1 FROM purchase_order_items WHERE purchase_id=? AND received_qty<quantity) THEN 'partial' ELSE 'received' END WHERE id=?").bind(orderId, orderId),
      ]);
    } catch {
      const repeated = await db.prepare("SELECT id,purchase_id FROM purchase_receipts WHERE idempotency_key=?").bind(key).first<{ id: string; purchase_id: string }>();
      if (repeated?.purchase_id === orderId) return json({ id: repeated.id, repeated: true });
      throw new InputError("Закупка или склад изменились. Обновите данные приёмки.", 409);
    }
    return json({ id: receiptId }, 201);
  }
  throw new InputError("Документ не найден.", 404);
}
