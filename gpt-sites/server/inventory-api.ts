import { InputError, text, normalize, positiveInt, stockValue, validateRows, mergeCart, customerPrice } from "../lib/inventory-domain";
import { restoreBackup } from "./backup";
import { backupTables } from "./backup";
import { replaceCatalog } from "./catalog";
import { purchaseApi, purchasingNeeds } from "./purchases";
import { integrationStatus, previewCatalogue, type IntegrationEnv, type Provider } from "./integrations";
import sourceSnapshot from "./source-snapshot.json";
import { supplierApi, supplierForPrice, supplierVisible, linkLegacySuppliers } from "./suppliers";
import { orderSettings, saveOrderSettings, type OrderSettingsEnv } from "./shop-settings";

type Identity = { userId: string; email: string; displayName: string };
type Bindings = { DB?: D1Database; BUCKET?: R2Bucket } & IntegrationEnv & OrderSettingsEnv;
type Customer = { id: string; auth_user_id: string | null; email: string; name: string; role: string; discount_bps: number; markup_bps: number; created_at: string };
type Product = { id: string; import_id: string; code: string; brand: string; name: string; stock: number | null; price_cents: number; source_name: string; source_type: string; lead_days: number | null; warehouse: string; bin: string; min_stock: number };
type Order = { id: string; customer_id: string; idempotency_key: string; total_cents: number; status: string; comment: string; created_at: string; customer_name?: string; customer_email?: string };
const now = () => new Date().toISOString();
const id = () => crypto.randomUUID();
const activeImports = "SELECT value FROM settings WHERE key LIKE 'active_import:%'";
const productSelect = "SELECT p.*,i.source_name,i.source_type,i.lead_days FROM products p JOIN imports i ON i.id=p.import_id";
const offer = (p: Product, me: Customer | null) => ({ id: p.id, code: p.code, brand: p.brand, name: p.name, stock: p.stock, priceCents: customerPrice(p.price_cents, me?.discount_bps ?? 0, me?.markup_bps ?? 0), sourceName: p.source_type === "warehouse" ? p.source_name : "Поставщик", sourceType: p.source_type, leadDays: p.lead_days, ...(me?.role === "admin" ? { sourceName: p.source_name, warehouse: p.warehouse || p.source_name, bin: p.bin, minStock: p.min_stock, basePriceCents: p.price_cents } : {}) });
const json = (v: unknown, status = 200) => Response.json(v, { status, headers: { "Cache-Control": "no-store" } });
async function all<T>(db: D1Database, sql: string, ...values: (string | number | null)[]): Promise<T[]> {
  return (await db.prepare(sql).bind(...values).all<T>()).results;
}
async function setting(db: D1Database, key: string) {
  return (await db.prepare("SELECT value FROM settings WHERE key=?").bind(key).first<{ value: string }>())?.value ?? null;
}
async function currentCustomer(db: D1Database, user: Identity): Promise<Customer> {
  const email = user.email.trim().toLowerCase();
  let found = await db.prepare("SELECT * FROM customers WHERE auth_user_id=?").bind(user.userId).first<Customer>();
  if (found) return found;
  found = await db.prepare("SELECT * FROM customers WHERE email=?").bind(email).first<Customer>();
  if (found) {
    if (found.auth_user_id && found.auth_user_id !== user.userId) throw new InputError("Учётная запись уже связана с другим пользователем.", 403);
    await db.prepare("UPDATE customers SET auth_user_id=? WHERE id=? AND auth_user_id IS NULL").bind(user.userId, found.id).run();
  } else {
    const customerId = id();
    await db.batch([
      db.prepare("INSERT OR IGNORE INTO customers (id,auth_user_id,email,name,role,discount_bps,created_at) VALUES (?,?,?,?,'customer',0,?)")
        .bind(customerId, user.userId, email, user.displayName.slice(0, 200), now()),
      db.prepare("INSERT OR IGNORE INTO settings (key,value) SELECT 'admin_customer_id',id FROM customers WHERE auth_user_id=?").bind(user.userId),
      db.prepare("UPDATE customers SET role='admin' WHERE id=(SELECT value FROM settings WHERE key='admin_customer_id') AND auth_user_id=?").bind(user.userId),
    ]);
  }
  const result = await db.prepare("SELECT * FROM customers WHERE auth_user_id=?").bind(user.userId).first<Customer>();
  if (!result) throw new InputError("Не удалось создать кабинет.", 503);
  return result;
}
function admin(customer: Customer | null): asserts customer is Customer {
  if (!customer || customer.role !== "admin") throw new InputError("Доступ только для администратора.", 403);
}
function signedIn(customer: Customer | null): asserts customer is Customer {
  if (!customer) throw new InputError("Войдите через ChatGPT, чтобы продолжить.", 401);
}
async function readBody(request: Request) {
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > 8_000_000) throw new InputError("Файл слишком большой. Максимум 8 МБ.", 413);
  const raw = await request.text();
  if (raw.length > 8_000_000) throw new InputError("Данные слишком большие.", 413);
  try { const value = JSON.parse(raw); if (!value || typeof value !== "object") throw new Error(); return value; } catch { throw new InputError("Не удалось прочитать данные."); }
}
async function orderDetails(db: D1Database, order: Order) {
  const items = await all(db, "SELECT product_id,code,brand,name,quantity,unit_price_cents,source_name,source_type,lead_days FROM order_items WHERE order_id=? ORDER BY rowid", order.id);
  return { ...order, items };
}

export async function inventoryApi(request: Request, env: Bindings, user: Identity | null): Promise<Response> {
  try {
    if (!env.DB) throw new InputError("Хранилище сайта ещё подключается. Попробуйте чуть позже.", 503);
    const db = env.DB;
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, "");
    const method = request.method;
    if (method !== "GET" && method !== "HEAD") {
      const origin = request.headers.get("origin");
      if (origin && origin !== url.origin) throw new InputError("Запрос должен исходить с этого сайта.", 403);
    }
    const me = user ? await currentCustomer(db, user) : null;
    if (path === "/api/suppliers" || path.startsWith("/api/suppliers/")) {
      admin(me); return await supplierApi(request, db);
    }
    if (path === "/api/shop-settings" && (method === "GET" || method === "PATCH")) {
      admin(me); return json(method === "GET" ? await orderSettings(db, env) : await saveOrderSettings(db, await readBody(request)));
    }
    if (path.startsWith("/api/purchase-orders")) {
      admin(me); return await purchaseApi(request, db, me.id);
    }
    if (path === "/api/me" && method === "GET") {
      const price = await db.prepare("SELECT filename,created_at,row_count FROM imports i WHERE id IN (" + activeImports + ") AND " + supplierVisible() + " ORDER BY created_at DESC LIMIT 1").first();
      const count = await db.prepare("SELECT COUNT(*) AS count FROM products p JOIN imports i ON i.id=p.import_id WHERE p.import_id IN (" + activeImports + ") AND " + supplierVisible()).first<{ count: number }>();
      return json({ user: me ? { id: me.id, name: me.name, email: me.email, role: me.role, discountBps: me.discount_bps } : null, price, productCount: count?.count ?? 0 });
    }
    if (path === "/api/integrations" && method === "GET") {
      admin(me); return json({ integrations: integrationStatus(env) });
    }
    if (/^\/api\/integrations\/(moysklad|saby)\/check$/.test(path) && method === "POST") {
      admin(me);
      const data = await readBody(request);
      return json(await previewCatalogue(path.split("/")[3] as Provider, env, data.cursor ?? 0));
    }
    if (path === "/api/products" && method === "GET") {
      const query = normalize(url.searchParams.get("q") ?? "").slice(0, 120);
      const page = Math.floor(Math.max(0, Math.min(1000, Number(url.searchParams.get("page")) || 0)));
      const terms = query.split(" ").filter(Boolean).slice(0, 8);
      const source = url.searchParams.get("source");
      const where = "p.import_id IN (" + activeImports + ") AND " + supplierVisible() + terms.map(() => " AND instr(p.search_text,?)>0").join("") + (source === "warehouse" || source === "supplier" ? " AND i.source_type=?" : "");
      const args = [...terms, ...(source === "warehouse" || source === "supplier" ? [source] : [])];
      const rows = await all<Product>(db, productSelect + " WHERE " + where + " ORDER BY p.code,i.source_type DESC,p.price_cents LIMIT 60 OFFSET ?", ...args, page * 60);
      const count = await db.prepare("SELECT COUNT(*) AS n FROM products p JOIN imports i ON i.id=p.import_id WHERE " + where).bind(...args).first<{ n: number }>();
      return json({ items: rows.map(p => offer(p, me)), total: count?.n ?? 0, page });
    }
    if (path === "/api/imports" && method === "POST") {
      admin(me);
      const form = await request.formData();
      const file = form.get("file");
      const encoded = form.get("rows");
      if (typeof encoded !== "string" || encoded.length > 6_000_000) throw new InputError("Не удалось прочитать строки прайса.");
      let decoded;
      try { decoded = JSON.parse(encoded); } catch { throw new InputError("Повреждённый прайс."); }
      const rows = validateRows(decoded);
      const sourceType = form.get("sourceType") === "supplier" ? "supplier" : "warehouse";
      const supplier = sourceType === "supplier" ? await supplierForPrice(db, form.get("supplierId"), form.get("sourceName")) : null;
      const sourceName = supplier?.name ?? text(form.get("sourceName") ?? "Мой склад", "Источник прайса", 120);
      const days = form.get("leadDays");
      const leadDays = days === null || days === "" ? supplier?.lead_days ?? null : Number(days);
      if (leadDays !== null && (!Number.isSafeInteger(leadDays) || leadDays < 0 || leadDays > 365)) throw new InputError("Срок поставки должен быть от 0 до 365 дней.");
      if (!(file instanceof File) || file.size > 8_000_000) throw new InputError("Прикрепите прайс размером до 8 МБ.");
      if (!env.BUCKET) throw new InputError("Хранилище файлов недоступно.", 503);
      const stockMode = form.get("stockMode") === "physical" ? "physical" : "available";
      const result = await replaceCatalog(db, env.BUCKET, { rows, sourceName, sourceType, leadDays, stockMode, supplierId: supplier?.id, supplierRevision: supplier?.revision, filename: file.name, content: await file.arrayBuffer(), contentType: file.type || "application/octet-stream" });
      return json({ count: result.count, filename: result.filename });
    }
    if (path === "/api/products" && method === "POST") {
      admin(me);
      if (!env.BUCKET) throw new InputError("Хранилище файлов недоступно.", 503);
      const data = await readBody(request);
      const row = validateRows([data])[0];
      const sourceName = text(data.sourceName ?? "Мой склад", "Название склада", 120);
      const warehouse = text(data.warehouse ?? sourceName, "Склад", 120, false), bin = text(data.bin ?? "", "Ячейка", 80, false);
      const minStock = stockValue(data.minStock ?? 0) ?? 0;
      const current = await all<Product>(db, productSelect + " WHERE p.import_id IN (" + activeImports + ") AND i.source_type='warehouse' AND i.source_name=?", sourceName);
      if (current.some(x => normalize(x.code) === normalize(row.code) && normalize(x.brand) === normalize(row.brand))) throw new InputError("Этот артикул и бренд уже есть на выбранном складе. Измените его остаток в таблице.", 409);
      const rows = [...current.map(x => ({ code: x.code, brand: x.brand, name: x.name, stock: x.stock, priceCents: x.price_cents })), { ...row, warehouse, bin, minStock }];
      validateRows(rows);
      const result = await replaceCatalog(db, env.BUCKET, { rows, sourceName, sourceType: "warehouse", leadDays: 0, stockMode: "available", filename: "Ручное-добавление.json", content: new TextEncoder().encode(JSON.stringify(rows)).buffer as ArrayBuffer, contentType: "application/json" });
      return json({ id: result.productIds.at(-1), count: result.count }, 201);
    }
    if (path === "/api/orders" && method === "POST") {
      signedIn(me);
      const data = await readBody(request);
      const key = text(data.idempotencyKey, "Ключ заказа", 80);
      const existing = await db.prepare("SELECT * FROM orders WHERE customer_id=? AND idempotency_key=?").bind(me.id, key).first<Order>();
      if (existing) return json({ order: await orderDetails(db, existing), repeated: true });
      const lines = mergeCart(data.items);
      const products = await all<Product>(db, productSelect + " WHERE p.id IN (" + lines.map(() => "?").join(",") + ") AND p.import_id IN (" + activeImports + ") AND " + supplierVisible(), ...lines.map(x => x.productId));
      const mapped = lines.map(line => {
        const product = products.find(p => p.id === line.productId);
        if (!product) throw new InputError("Прайс обновлён. Обновите корзину и выберите товары заново.", 409);
        if (product.stock !== null && product.stock < line.quantity) throw new InputError("Недостаточно товара «" + product.name + "». Доступно: " + product.stock + ".", 409);
        const price = customerPrice(product.price_cents, me.discount_bps, me.markup_bps);
        const originals = data.items.filter((x: { productId: string }) => x.productId === line.productId);
        if (originals.some((x: { expectedPriceCents?: number }) => x.expectedPriceCents !== undefined && x.expectedPriceCents !== price)) throw new InputError("Цена изменилась. Обновите цены в корзине перед оформлением.", 409);
        return { ...line, product, price };
      });
      const total = mapped.reduce((sum, x) => sum + x.price * x.quantity, 0);
      positiveInt(total, "Сумма заказа", Number.MAX_SAFE_INTEGER);
      const orderId = id();
      const created = now();
      const comment = text(data.comment ?? "", "Комментарий", 2000, false);
      const pos = data.channel === "pos";
      if (pos) admin(me);
      if (pos && mapped.some(x => x.product.source_type !== "warehouse")) throw new InputError("Для продажи с прилавка выберите товары своего склада. Предложения поставщиков оформляются отдельным заказом.", 409);
      const pay = data.payFromBalance === true;
      const balance = await db.prepare("SELECT COALESCE(SUM(amount_cents),0) AS balance FROM ledger WHERE customer_id=?").bind(me.id).first<{ balance: number }>();
      if (pay && (balance?.balance ?? 0) < total) throw new InputError("Недостаточно средств на балансе.", 409);
      const lineData = JSON.stringify(mapped.map(x => ({ ...x, itemId: id(), movementId: id() })));
      const stmts = [
        db.prepare("INSERT INTO orders (id,customer_id,idempotency_key,total_cents,status,comment,created_at,channel,fiscal_status) SELECT ?,?,?,?,?,?,?,?,'not_sent' WHERE ?=(SELECT COUNT(*) FROM products p JOIN imports i ON i.id=p.import_id JOIN json_each(?) r ON p.id=json_extract(r.value,'$.productId') WHERE p.import_id=json_extract(r.value,'$.product.import_id') AND p.price_cents=json_extract(r.value,'$.product.price_cents') AND p.import_id IN (" + activeImports + ") AND " + supplierVisible() + " AND (p.stock IS NULL OR p.stock>=json_extract(r.value,'$.quantity'))) AND EXISTS (SELECT 1 FROM customers WHERE id=? AND markup_bps=? AND discount_bps=?)" + (pay ? " AND (SELECT COALESCE(SUM(amount_cents),0) FROM ledger WHERE customer_id=?)>=?" : "")).bind(orderId, me.id, key, total, pos ? "completed" : "new", comment, created, pos ? "pos" : "online", mapped.length, lineData, me.id, me.markup_bps, me.discount_bps, ...(pay ? [me.id, total] : [])),
        db.prepare("INSERT INTO order_items (id,order_id,product_id,code,brand,name,quantity,unit_price_cents,source_name,source_type,lead_days) SELECT json_extract(value,'$.itemId'),?,json_extract(value,'$.productId'),json_extract(value,'$.product.code'),json_extract(value,'$.product.brand'),json_extract(value,'$.product.name'),json_extract(value,'$.quantity'),json_extract(value,'$.price'),json_extract(value,'$.product.source_name'),json_extract(value,'$.product.source_type'),json_extract(value,'$.product.lead_days') FROM json_each(?)").bind(orderId, lineData),
        db.prepare("INSERT INTO stock_movements (id,product_id,delta,kind,reference_id,created_at) SELECT json_extract(r.value,'$.movementId'),p.id,CASE WHEN p.stock IS NULL THEN NULL ELSE -json_extract(r.value,'$.quantity') END,'order',?,? FROM json_each(?) r JOIN products p ON p.id=json_extract(r.value,'$.productId')").bind(orderId, created, lineData),
        db.prepare("UPDATE products SET stock=CASE WHEN stock IS NULL THEN NULL ELSE stock-(SELECT json_extract(value,'$.quantity') FROM json_each(?) WHERE json_extract(value,'$.productId')=products.id) END WHERE id IN (SELECT json_extract(value,'$.productId') FROM json_each(?))").bind(lineData, lineData),
        ...(pay ? [db.prepare("INSERT INTO ledger (id,customer_id,amount_cents,kind,reference_id,created_at) VALUES (?,?,?,'order',?,?)").bind(id(), me.id, -total, orderId, created)] : []),
      ];
      try { await db.batch(stmts); } catch {
        const retry = await db.prepare("SELECT * FROM orders WHERE customer_id=? AND idempotency_key=?").bind(me.id, key).first<Order>();
        if (retry) return json({ order: await orderDetails(db, retry), repeated: true });
        throw new InputError("Остатки или прайс изменились. Обновите корзину и повторите заказ.", 409);
      }
      const savedOrder = await db.prepare("SELECT * FROM orders WHERE id=?").bind(orderId).first<Order>();
      if (!savedOrder) throw new InputError("Заказ не был сохранён. Обновите корзину и повторите оформление.", 409);
      return json({ order: await orderDetails(db, savedOrder) }, 201);
    }
    if (path === "/api/orders" && method === "GET") {
      signedIn(me);
      const items = await all<Order>(db, "SELECT o.*,c.name AS customer_name,c.email AS customer_email FROM orders o JOIN customers c ON c.id=o.customer_id" + (me.role === "admin" ? "" : " WHERE o.customer_id=?") + " ORDER BY o.created_at DESC LIMIT 150", ...(me.role === "admin" ? [] : [me.id]));
      const lines = await all<{ order_id: string; [key: string]: unknown }>(db, "SELECT order_id,product_id,code,brand,name,quantity,unit_price_cents,source_name,source_type,lead_days FROM order_items WHERE order_id IN (SELECT value FROM json_each(?)) ORDER BY rowid", JSON.stringify(items.map(x => x.id)));
      return json({ orders: items.map(order => ({ ...order, items: lines.filter(line => line.order_id === order.id).map(({ order_id: _orderId, ...line }) => line) })) });
    }
    if (path === "/api/cart" && method === "POST") {
      const data = await readBody(request);
      const lines = mergeCart(data.items);
      const rows = await all<Product>(db, productSelect + " WHERE p.id IN (" + lines.map(() => "?").join(",") + ") AND p.import_id IN (" + activeImports + ")", ...lines.map(x => x.productId));
      return json({ items: rows.map(p => offer(p, me)), removed: lines.filter(x => !rows.some(p => p.id === x.productId)).map(x => x.productId) });
    }
    if (path === "/api/vin" && method === "POST") {
      signedIn(me);
      const data = await readBody(request);
      const vin = text(data.vin, "VIN", 17).toUpperCase();
      if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) throw new InputError("VIN должен содержать 17 латинских букв и цифр, без I, O и Q.");
      const vehicle = text(data.vehicle ?? "", "Автомобиль", 200, false);
      const details = text(data.details, "Нужные детали", 2000);
      const requestId = id();
      await db.prepare("INSERT INTO vin_requests (id,customer_id,vin,vehicle,details,answer,status,created_at) VALUES (?,?,?,?,?,'','new',?)").bind(requestId, me.id, vin, vehicle, details, now()).run();
      return json({ id: requestId }, 201);
    }
    if (path === "/api/vin" && method === "GET") {
      signedIn(me);
      const rows = await all(db, "SELECT v.*,c.name AS customer_name FROM vin_requests v JOIN customers c ON c.id=v.customer_id" + (me.role === "admin" ? "" : " WHERE v.customer_id=?") + " ORDER BY v.created_at DESC LIMIT 100", ...(me.role === "admin" ? [] : [me.id]));
      return json({ requests: rows, catalogConnected: false });
    }
    if (/^\/api\/vin\/[^/]+$/.test(path) && method === "PATCH") {
      admin(me);
      const data = await readBody(request);
      const answer = text(data.answer, "Ответ", 4000);
      await db.prepare("UPDATE vin_requests SET answer=?,status='answered' WHERE id=?").bind(answer, path.split("/").pop()!).run();
      return json({ ok: true });
    }
    if (path === "/api/wallet" && method === "GET") {
      signedIn(me);
      const balance = await db.prepare("SELECT COALESCE(SUM(amount_cents),0) AS balance FROM ledger WHERE customer_id=?").bind(me.id).first<{ balance: number }>();
      return json({ balanceCents: balance?.balance ?? 0, transactions: await all(db, "SELECT * FROM ledger WHERE customer_id=? ORDER BY created_at DESC LIMIT 100", me.id), topups: await all(db, "SELECT t.*,c.name AS customer_name,c.email AS customer_email FROM topups t JOIN customers c ON c.id=t.customer_id" + (me.role === "admin" ? "" : " WHERE t.customer_id=?") + " ORDER BY t.created_at DESC LIMIT 100", ...(me.role === "admin" ? [] : [me.id])) });
    }
    if (path === "/api/wallet" && method === "POST") {
      signedIn(me);
      const data = await readBody(request);
      const amount = positiveInt(data.amountCents, "Сумма пополнения", 100000000);
      const reference = text(data.reference, "Номер или описание перевода", 300);
      const topupId = id();
      await db.prepare("INSERT INTO topups (id,customer_id,amount_cents,reference,status,created_at) VALUES (?,?,?,?,'pending',?)").bind(topupId, me.id, amount, reference, now()).run();
      return json({ id: topupId }, 201);
    }
    if (/^\/api\/wallet\/[^/]+$/.test(path) && method === "PATCH") {
      admin(me);
      const topupId = path.split("/").pop()!;
      const data = await readBody(request);
      if (data.action !== "approve" && data.action !== "reject") throw new InputError("Неизвестное действие.");
      if (data.action === "reject") { await db.prepare("UPDATE topups SET status='rejected' WHERE id=? AND status='pending'").bind(topupId).run(); return json({ ok: true }); }
      const created = now();
      await db.batch([
        db.prepare("INSERT OR IGNORE INTO ledger (id,customer_id,amount_cents,kind,reference_id,created_at) SELECT ?,customer_id,amount_cents,'topup',id,? FROM topups WHERE id=? AND status='pending'").bind(id(), created, topupId),
        db.prepare("UPDATE topups SET status='approved',approved_at=? WHERE id=? AND status='pending'").bind(created, topupId),
      ]);
      return json({ ok: true });
    }
    if (/^\/api\/orders\/[^/]+$/.test(path) && method === "PATCH") {
      admin(me);
      const orderId = path.split("/").pop()!;
      const data = await readBody(request);
      const status = text(data.status, "Статус", 20);
      const allowed = ["new", "processing", "ready", "completed", "cancelled"];
      if (!allowed.includes(status)) throw new InputError("Неизвестный статус.");
      const order = await db.prepare("SELECT * FROM orders WHERE id=?").bind(orderId).first<Order>();
      if (!order) throw new InputError("Заказ не найден.", 404);
      if (order.status === "cancelled" && status !== "cancelled") throw new InputError("Отменённый заказ нельзя открыть повторно.", 409);
      if (order.status === "completed" && status !== "completed") throw new InputError("Завершённый заказ нельзя открыть или отменить. Возврат оформляется отдельной операцией.", 409);
      if (status === "cancelled" && order.status !== "cancelled") {
        if (order.status === "completed") throw new InputError("Завершённый заказ нельзя отменить.", 409);
        await db.batch([
          db.prepare("INSERT INTO stock_movements (id,product_id,delta,kind,reference_id,created_at) SELECT 'return:'||oi.id,p.id,CASE WHEN p.stock IS NULL THEN NULL ELSE oi.quantity END,'return',?,? FROM order_items oi JOIN products p ON p.id=oi.product_id WHERE oi.order_id=? AND EXISTS (SELECT 1 FROM orders WHERE id=? AND status NOT IN ('cancelled','completed'))").bind(orderId, now(), orderId, orderId),
          db.prepare("UPDATE products SET stock=stock+(SELECT SUM(quantity) FROM order_items WHERE order_id=? AND product_id=products.id) WHERE id IN (SELECT product_id FROM order_items WHERE order_id=?) AND stock IS NOT NULL AND EXISTS (SELECT 1 FROM orders WHERE id=? AND status NOT IN ('cancelled','completed'))").bind(orderId, orderId, orderId),
          db.prepare("INSERT OR IGNORE INTO ledger (id,customer_id,amount_cents,kind,reference_id,created_at) SELECT ?,customer_id,-amount_cents,'refund',?,? FROM ledger WHERE reference_id=? AND kind='order' AND EXISTS (SELECT 1 FROM orders WHERE id=? AND status NOT IN ('cancelled','completed'))").bind(id(), "refund:" + orderId, now(), orderId, orderId),
          db.prepare("UPDATE orders SET status='cancelled' WHERE id=? AND status NOT IN ('cancelled','completed')").bind(orderId),
        ]);
      } else {
        await db.prepare("UPDATE orders SET status=? WHERE id=? AND status NOT IN ('cancelled','completed')").bind(status, orderId).run();
      }
      const current = await db.prepare("SELECT status FROM orders WHERE id=?").bind(orderId).first<{ status: string }>();
      if (current?.status !== status) throw new InputError("Статус заказа изменился во время операции. Обновите список заказов.", 409);
      return json({ ok: true });
    }
    if (path === "/api/customers" && method === "GET") {
      admin(me);
      return json({ customers: await all(db, "SELECT id,name,email,role,discount_bps,markup_bps,created_at,(SELECT COALESCE(SUM(amount_cents),0) FROM ledger WHERE customer_id=customers.id) AS balance_cents FROM customers ORDER BY created_at DESC") });
    }
    if (/^\/api\/customers\/[^/]+$/.test(path) && method === "PATCH") {
      admin(me);
      const data = await readBody(request);
      const markup = data.markupBps;
      if (!Number.isSafeInteger(markup) || markup < 0 || markup > 100000) throw new InputError("Наценка должна быть от 0 до 1000%.");
      await db.prepare("UPDATE customers SET markup_bps=? WHERE id=?").bind(markup, path.split("/").pop()!).run();
      return json({ ok: true });
    }
    if (/^\/api\/products\/[^/]+$/.test(path) && method === "PATCH") {
      admin(me);
      const data = await readBody(request);
      const productId = path.split("/").pop()!;
      const stock = stockValue(data.stock);
      const warehouse = text(data.warehouse ?? "", "Склад", 120, false), bin = text(data.bin ?? "", "Ячейка", 80, false);
      const minStock = stockValue(data.minStock ?? 0) ?? 0;
      await db.batch([
        db.prepare("INSERT INTO stock_movements (id,product_id,delta,kind,reference_id,created_at) SELECT ?,id,?-stock,'adjustment',?,? FROM products WHERE id=? AND import_id IN (" + activeImports + ")").bind(id(), stock, me.id, now(), productId),
        db.prepare("UPDATE products SET stock=?,warehouse=?,bin=?,min_stock=? WHERE id=? AND import_id IN (" + activeImports + ")").bind(stock, warehouse, bin, minStock, productId),
      ]);
      return json({ ok: true });
    }
    if (path === "/api/movements" && method === "GET") {
      admin(me);
      return json({ movements: await all(db, "SELECT m.*,p.code,p.name,p.warehouse,p.bin FROM stock_movements m JOIN products p ON p.id=m.product_id ORDER BY m.created_at DESC LIMIT 150") });
    }
    if (path === "/api/labels" && method === "GET") {
      admin(me);
      const ids = (url.searchParams.get("ids") ?? "").split(",").filter(Boolean).slice(0, 60);
      if (!ids.length) throw new InputError("Выберите товары для печати.");
      const rows = await all<Product>(db, productSelect + " WHERE p.id IN (" + ids.map(() => "?").join(",") + ") AND p.import_id IN (" + activeImports + ")", ...ids);
      return json({ items: rows.map(p => offer(p, me)) });
    }
    if (path === "/api/purchasing" && method === "GET") {
      admin(me);
      const needs = await purchasingNeeds(db);
      return json({ needs: needs.map(n => ({ product: offer(n.product, me), quantity: n.quantity, incomingQty: n.incomingQty, recommendedId: n.recommendedId,
        offers: n.offers.map(s => ({ ...offer(s, me), basePriceCents: s.price_cents, availableForPurchase: s.stock === null ? null : Math.max(0, s.stock-s.planned_qty) })) })), source: "uploaded-prices", automaticOrderingConnected: false });
    }
    if (path === "/api/backup" && method === "GET") {
      admin(me);
      await orderSettings(db, env);
      await linkLegacySuppliers(db);
      const tables = backupTables;
      const records = await db.batch(tables.map(table => db.prepare(table === "customers" ? "SELECT id,email,name,role,discount_bps,markup_bps,created_at FROM customers" : "SELECT * FROM " + table)));
      const dump: Record<string, unknown> = { format: "inventory-atoll", version: 3, exportedAt: now(), ...Object.fromEntries(tables.map((table, index) => [table, records[index].results])) };
      return json(dump);
    }
    if (path === "/api/restore" && method === "POST") {
      admin(me);
      if (!env.BUCKET) throw new InputError("Хранилище файлов недоступно.", 503);
      return json(await restoreBackup(db, env.BUCKET, await request.formData(), me));
    }
    if (path === "/api/source" && method === "GET") {
      admin(me);
      if (!sourceSnapshot.archive) throw new InputError("Выгрузка кода будет доступна после сборки версии.", 503);
      return new Response(Uint8Array.from(atob(sourceSnapshot.archive), c => c.charCodeAt(0)), { headers: { "Content-Type": "application/zip", "Content-Disposition": 'attachment; filename="Inventory-Atoll-source.zip"', "Cache-Control": "no-store" } });
    }
    if (path === "/api/import-files" && method === "GET") {
      admin(me);
      return json({ files: await all(db, "SELECT id,filename,file_key FROM imports WHERE file_key IS NOT NULL") });
    }
    if (/^\/api\/import-files\/[^/]+$/.test(path) && method === "GET") {
      admin(me);
      const row = await db.prepare("SELECT filename,file_key FROM imports WHERE id=?").bind(path.split("/").pop()!).first<{ filename: string; file_key: string }>();
      const file = row?.file_key && env.BUCKET ? await env.BUCKET.get(row.file_key) : null;
      if (!file) throw new InputError("Файл не найден.", 404);
      return new Response(file.body, { headers: { "Content-Type": "application/octet-stream", "Cache-Control": "no-store" } });
    }
    throw new InputError("Страница не найдена.", 404);
  } catch (error) {
    if (error instanceof InputError) return json({ error: error.message }, error.status);
    console.error("Inventory request failed", error instanceof Error ? error.message : "unknown");
    return json({ error: "Операция не завершена. Попробуйте ещё раз." }, 500);
  }
}
