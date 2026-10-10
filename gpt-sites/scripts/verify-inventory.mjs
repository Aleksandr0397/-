import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { zipSync, unzipSync } from "fflate";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const require = createRequire(realpathSync(join(root, "node_modules/wrangler/package.json")));
const { build } = require("esbuild");
const { Miniflare, Log, LogLevel } = require("miniflare");
const sharp = createRequire(require.resolve("miniflare"))("sharp");
const directory = join(root, ".sites-runtime/verification", crypto.randomUUID());
await mkdir(directory, { recursive: true });
const bundle = join(directory, "worker.mjs");
await build({
  stdin: {
    contents: `import { inventoryApi } from "./server/inventory-api.ts";
      export default { fetch(request, env) {
        const userId = request.headers.get("x-test-user");
        const user = userId ? { userId, email: request.headers.get("x-test-email"), displayName: userId } : null;
        const hostname = new URL(request.url).hostname;
        const DB = hostname === "v1restore.atoll.test" ? env.V1_RESTORE_DB : hostname === "v3restore.atoll.test" ? env.V3_RESTORE_DB : hostname === "legacyrestore.atoll.test" ? env.LEGACY_RESTORE_DB : hostname === "restore.atoll.test" ? env.RESTORE_DB : env.DB;
        let queries = 0;
        const statements = new WeakMap();
        function count(n = 1) { queries += n; if (queries > 50) throw new Error("Verification: D1 query budget exceeded"); }
        function wrap(stmt) {
          const result = { bind(...args) { return wrap(stmt.bind(...args)); } };
          for (const method of ["all", "first", "run", "raw"]) result[method] = (...args) => { count(); return stmt[method](...args); };
          statements.set(result, stmt); return result;
        }
        const metered = { prepare(sql) { return wrap(DB.prepare(sql)); }, batch(list) { count(list.length); return DB.batch(list.map(x => statements.get(x))); } };
        return inventoryApi(request, { DB: metered, BUCKET: env.BUCKET, ORDER_NOTIFICATION_EMAIL: "receiver@atoll.test" }, user).then(response => {
          const headers = new Headers(response.headers); headers.set("x-test-queries", String(queries));
          return new Response(response.body, { status: response.status, headers });
        });
      } };`,
    resolveDir: root, sourcefile: "verification-worker.ts", loader: "ts",
  },
  outfile: bundle, bundle: true, format: "esm", platform: "browser", target: "es2022",
});
const helpersBundle = join(directory, "helpers.mjs");
await build({ stdin: { contents: 'export { checkoutAttempt, pendingCheckout, completeCheckout } from "./lib/checkout-attempt.ts"; export { mutationAttempt, pendingMutation, completeMutation } from "./lib/mutation-attempt.ts"; export { createBackupManifest } from "./lib/backup-integrity.ts"; export { previewCatalogue } from "./server/integrations.ts"; export { linkLegacySuppliers } from "./server/suppliers.ts";', resolveDir: root, sourcefile: "verify-helpers.ts", loader: "ts" }, outfile: helpersBundle, bundle: true, format: "esm", platform: "node", target: "es2022" });
const { checkoutAttempt, pendingCheckout, completeCheckout, previewCatalogue, mutationAttempt, pendingMutation, completeMutation, createBackupManifest, linkLegacySuppliers } = await import(pathToFileURL(helpersBundle).href);
const options = {
  modules: true, scriptPath: bundle, compatibilityDate: "2026-05-01", cf: false,
  log: new Log(LogLevel.ERROR), d1Databases: { DB: "test-atoll", RESTORE_DB: "test-restore", LEGACY_RESTORE_DB: "test-legacy-restore", V1_RESTORE_DB: "test-v1-restore", V3_RESTORE_DB: "test-v3-restore", UPGRADE_DB: "test-upgrade" },
  r2Buckets: ["BUCKET"], d1Persist: join(directory, "d1"), r2Persist: join(directory, "r2"),
};
let runtime = new Miniflare(options);
const owner = { id: "owner", email: "owner@atoll.test" };
const client = { id: "client", email: "client@atoll.test" };
const other = { id: "other", email: "other@atoll.test" };
let passed = 0, failed = 0;
async function check(name, operation) {
  try { await operation(); passed++; console.log("PASS", name); }
  catch (error) { failed++; console.error("FAIL", name, error.message); }
}
async function api(path, { user = owner, method = "GET", body, restore = false } = {}) {
  const headers = user ? { "x-test-user": user.id, "x-test-email": user.email } : {};
  if (body instanceof FormData) {
    const serialized = new Request("http://app.atoll.test", { method, body });
    headers["content-type"] = serialized.headers.get("content-type");
    body = await serialized.arrayBuffer();
  } else if (body) { headers["content-type"] = "application/json"; body = JSON.stringify(body); }
  const response = await runtime.dispatchFetch("http://" + (restore === "v1" ? "v1restore" : restore === "v3" ? "v3restore" : restore === "legacy" ? "legacyrestore" : restore ? "restore" : "app") + ".atoll.test" + path, { method, headers, body });
  const raw = await response.text();
  let data; try { data = JSON.parse(raw); } catch { data = raw; }
  return { status: response.status, data, queries: Number(response.headers.get("x-test-queries")) };
}
async function importPrice(rows, sourceName = "Основной склад", sourceType = "warehouse", stockMode = "available", expectedStatus = 200, supplierId = null) {
  const form = new FormData();
  form.set("file", new Blob(["Артикул;Бренд;Название;Цена;Остаток\n" + rows.map(x => [x.code,x.brand,x.name,x.priceCents/100,x.stock ?? ""].join(";")).join("\n")]), "price.csv");
  form.set("rows", JSON.stringify(rows)); form.set("sourceName", sourceName);
  form.set("sourceType", sourceType); form.set("leadDays", sourceType === "warehouse" ? "0" : "3"); form.set("stockMode", stockMode);
  if (sourceType === "supplier") {
    if (!supplierId) {
      const existing = (await api("/api/suppliers")).data.suppliers.find(s => s.name.toLowerCase() === sourceName.toLowerCase());
      if (existing) supplierId = existing.id;
      else { const created = await api("/api/suppliers", { method: "POST", body: { name: sourceName, connectionType: "price", leadDays: 3 } }); assert.equal(created.status, 201, JSON.stringify(created.data)); supplierId = created.data.supplier.id; }
    }
    form.set("supplierId", supplierId);
  }
  const result = await api("/api/imports", { method: "POST", body: form });
  assert.equal(result.status, expectedStatus, JSON.stringify(result.data));
  return result;
}
const priceRows = [
  { code: "001-A", brand: "TEST", name: "Фильтр масляный", stock: 5, priceCents: 10000 },
  { code: "002-B", brand: "TEST", name: "Свеча зажигания", stock: 1, priceCents: 8000 },
];
let product, adminId, customerId, order, saleId;
let purchase, purchaseGoods;
const photoBytes = new Uint8Array(await sharp({ create: { width: 1, height: 1, channels: 3, background: '#447799' } }).png().toBuffer());
await sharp(photoBytes).raw().toBuffer(); // Positive fixture must decode, not just have a PNG header.
async function uploadPhoto(productId, bytes = photoBytes, user = owner) {
  const form = new FormData(); form.set("file", new Blob([bytes], { type: "image/png" }), "part.png");
  return api("/api/products/" + productId + "/photos", { method: "POST", body: form, user });
}
let savedPhoto;
try {
  await check("Все SQL-миграции применяются к пустой настоящей D1", async () => {
    for (const binding of ["DB", "RESTORE_DB", "LEGACY_RESTORE_DB", "V1_RESTORE_DB", "V3_RESTORE_DB"]) {
      const db = await runtime.getD1Database(binding);
      for (const file of (await readdir(join(root, "drizzle"))).filter(x => x.endsWith(".sql")).sort()) {
        const sql = await readFile(join(root, "drizzle", file), "utf8");
        await db.batch(sql.split("--> statement-breakpoint").map(x => x.trim()).filter(Boolean).map(x => db.prepare(x)));
      }
    }
  });
  if (failed) throw new Error("Миграции не прошли; дальнейшие проверки не запускались.");
  await check("Миграции сохраняют существующего клиента и его заказ", async () => {
    const db = await runtime.getD1Database("UPGRADE_DB");
    const migrations = (await readdir(join(root, "drizzle"))).filter(x => x.endsWith(".sql")).sort();
    const apply = async file => db.batch((await readFile(join(root, "drizzle", file), "utf8")).split("--> statement-breakpoint").map(x => x.trim()).filter(Boolean).map(x => db.prepare(x)));
    await apply(migrations[0]);
    await db.batch([
      db.prepare("INSERT INTO customers (id,email,name,created_at) VALUES ('old-client','old@atoll.test','Клиент','2026-01-01T00:00:00.000Z')"),
      db.prepare("INSERT INTO orders (id,customer_id,idempotency_key,total_cents,created_at) VALUES ('old-order','old-client','old-key',100,'2026-01-01T00:00:00.000Z')"),
    ]);
    for (const file of migrations.slice(1)) await apply(file);
    assert.equal((await db.prepare("SELECT markup_bps FROM customers WHERE id='old-client'").first()).markup_bps, 0);
    assert.equal((await db.prepare("SELECT customer_id FROM orders WHERE id='old-order'").first()).customer_id, 'old-client');
  });
  await check("Владелец получает админку, клиент не получает права администратора", async () => {
    const admin = await api("/api/me"); const customer = await api("/api/me", { user: client });
    assert.equal(admin.status, 200); assert.equal(admin.data.user.role, "admin"); adminId = admin.data.user.id;
    assert.equal(customer.data.user.role, "customer"); customerId = customer.data.user.id;
    assert.equal((await api("/api/backup", { user: client })).status, 403);
    assert.equal((await api("/api/orders", { user: null })).status, 401);
  });
  await check("Администратор создаёт поставщика вручную с настройками API", async () => {
    const result = await api("/api/suppliers", { method: "POST", body: { name: "Ручной API-поставщик", connectionType: "api", leadDays: 2, apiUrl: "https://parts.example.test/api", apiDocsUrl: "https://parts.example.test/docs" } });
    assert.equal(result.status, 201, JSON.stringify(result.data));
    const list = await api("/api/suppliers");
    assert.equal(list.status, 200); assert.ok(list.data.suppliers.some(s => s.id === result.data.supplier.id && s.connection_type === "api"));
  });
  await check("15 поставщиков с разными способами работы сохраняются независимо", async () => {
    for (let index = 0; index < 15; index++) {
      const type = ["price", "api", "both"][index % 3];
      const result = await api("/api/suppliers", { method: "POST", body: { name: "Поставщик карточка " + String(index + 1).padStart(2, "0"), connectionType: type, leadDays: index, contactName: "Менеджер " + index, email: "supplier" + index + "@atoll.test", notes: "Доставка по договору" } });
      assert.equal(result.status, 201, JSON.stringify(result.data)); assert.equal(result.data.supplier.connection_type, type);
    }
    const list = (await api("/api/suppliers")).data.suppliers;
    assert.equal(list.filter(s => s.name.startsWith("Поставщик карточка")).length, 15); assert.equal(new Set(list.map(s => s.id)).size, list.length);
    assert.ok(list.every(s => s.apiConnected === false));
  });
  await check("Справочник поставщиков защищён от клиента, дублей и неверных настроек", async () => {
    assert.equal((await api("/api/suppliers", { user: client })).status, 403);
    assert.equal((await api("/api/suppliers", { user: null, method: "POST", body: { name: "Чужой" } })).status, 403);
    const s = (await api("/api/suppliers")).data.suppliers[0];
    assert.equal((await api("/api/suppliers/" + s.id, { user: client, method: "PATCH", body: { enabled: false, expectedRevision: s.revision } })).status, 403);
    assert.equal((await api("/api/suppliers", { method: "POST", body: { name: "   РУЧНОЙ api-ПОСТАВЩИК   " } })).status, 409);
    assert.equal((await api("/api/suppliers", { method: "POST", body: { name: "№".repeat(80) } })).status, 201);
    for (const fields of [{ name: "" }, { name: "Ошибка", connectionType: "unknown" }, { name: "Ошибка", leadDays: -1 }, { name: "Ошибка", email: "bad" }, { name: "Ошибка", apiUrl: "https://user:secret@parts.test/api" }, { name: "Ошибка", apiUrl: "https://parts.test/api?token=secret" }]) assert.equal((await api("/api/suppliers", { method: "POST", body: fields })).status, 400);
    const form = new FormData(); form.set("file", new Blob(["test"]), "price.csv"); form.set("rows", JSON.stringify(priceRows)); form.set("sourceType", "supplier"); form.set("sourceName", "Не создан вручную");
    assert.equal((await api("/api/imports", { method: "POST", body: form })).status, 400);
  });
  await check("Старые прайсы связываются со справочником без потери товаров и повторных записей", async () => {
    const db = await runtime.getD1Database("UPGRADE_DB");
    await db.batch([
      db.prepare("INSERT INTO imports (id,filename,row_count,created_at,source_name,source_type,lead_days) VALUES ('legacy-price','old.csv',1,'2026-01-01T00:00:00.000Z','Старый поставщик','supplier',4)"),
      db.prepare("INSERT INTO products (id,import_id,code,brand,name,search_text,stock,price_cents) VALUES ('legacy-product','legacy-price','OLD','TEST','Старая деталь','old',7,15000)"),
      db.prepare("INSERT INTO settings (key,value) VALUES ('active_import:supplier:старый поставщик','legacy-price')"),
    ]);
    await linkLegacySuppliers(db); await linkLegacySuppliers(db);
    const rows = (await db.prepare("SELECT * FROM suppliers").all()).results; assert.equal(rows.length, 1); assert.equal(rows[0].lead_days, 4);
    assert.equal((await db.prepare("SELECT supplier_id FROM imports WHERE id='legacy-price'").first()).supplier_id, rows[0].id);
    assert.equal((await db.prepare("SELECT value FROM settings WHERE key=?").bind("active_import:supplier:" + rows[0].id).first()).value, "legacy-price");
    assert.equal((await db.prepare("SELECT stock FROM products WHERE id='legacy-product'").first()).stock, 7);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM settings WHERE key LIKE 'active_import:%'").first()).n, 1);
  });
  await check("Email заказов сохраняется, защищён от клиента и не обещает отправку без сервиса", async () => {
    const initial = await api("/api/shop-settings"); assert.equal(initial.status, 200); assert.equal(initial.data.orderEmail, "receiver@atoll.test"); assert.equal(initial.data.emailSendingConnected, false);
    assert.equal((await api("/api/shop-settings", { user: client })).status, 403);
    assert.equal((await api("/api/shop-settings", { user: client, method: "PATCH", body: { orderEmail: "thief@atoll.test" } })).status, 403);
    assert.equal((await api("/api/shop-settings", { method: "PATCH", body: { orderEmail: "bad" } })).status, 400);
    assert.equal((await api("/api/shop-settings", { method: "PATCH", body: { orderEmail: "Orders@atoll.test" } })).data.orderEmail, "orders@atoll.test");
    assert.equal((await api("/api/shop-settings")).data.orderEmail, "orders@atoll.test");
  });
  await check("После обрыва и перезагрузки сохраняются ключ заказа и выбранная оплата", async () => {
    const values = new Map(); const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
    const payload = { comment: "Заберу завтра", channel: "online", payFromBalance: true, items: [{ productId: "part-1", quantity: 2, expectedPriceCents: 12300 }] };
    const first = await checkoutAttempt("buyer-1", payload, storage);
    const restored = pendingCheckout("buyer-1", storage); assert.deepEqual(restored.payload, payload);
    const retry = await checkoutAttempt("buyer-1", restored.payload, storage); assert.equal(retry.key, first.key);
    assert.notEqual((await checkoutAttempt("buyer-2", payload, storage, first)).key, first.key);
    const edited = await checkoutAttempt("buyer-1", { ...payload, items: [{ ...payload.items[0], quantity: 3 }] }, storage);
    assert.notEqual(edited.key, first.key);
    completeCheckout(first, storage); assert.equal(pendingCheckout("buyer-1", storage).key, edited.key);
    completeCheckout(edited, storage); assert.equal(pendingCheckout("buyer-1", storage), null);
  });
  await check("Подключения защищены правами и не выдают ключи или ложный статус", async () => {
    const status = await api("/api/integrations"); assert.equal(status.status, 200);
    assert.ok(status.data.integrations.every(x => x.configured === false && x.missing.length));
    assert.equal((await api("/api/integrations", { user: client })).status, 403);
    assert.equal((await api("/api/integrations/moysklad/check", { method: "POST", body: {} })).status, 503);
    assert.equal((await api("/api/integrations/saby/check", { user: client, method: "POST", body: {} })).status, 403);
  });
  await check("Адаптер МойСклада выбирает заданную колонку цен и листает каталог", async () => {
    let requested;
    const env = { MOYSKLAD_TOKEN: "verification-token", MOYSKLAD_PRICE_TYPE_ID: "retail", MOYSKLAD_PRICE_UNIT: "kopecks" };
    const data = await previewCatalogue("moysklad", env, 25, async (url, options) => {
      requested = { url: new URL(url), options };
      return Response.json({ meta: { size: 60 }, rows: [{ id: "external-1", article: "001-A", name: "Фильтр", stock: 5, salePrices: [{ value: 5000, priceType: { id: "wholesale" } }, { value: 12300, priceType: { id: "retail" } }] }] });
    });
    assert.equal(requested.url.origin, "https://api.moysklad.ru"); assert.equal(requested.url.searchParams.get("offset"), "25");
    assert.equal(requested.options.headers.Authorization, "Bearer verification-token"); assert.equal(requested.options.redirect, "error");
    assert.equal(data.rows[0].priceCents, 12300); assert.equal(data.nextCursor, 26); assert.equal(data.mode, "preview");
  });
  await check("Адаптер Saby пропускает папки, сохраняет артикулы и проверяет формат ответа", async () => {
    const env = { SABY_ACCESS_TOKEN: "verification-token", SABY_POINT_ID: "7", SABY_PRICE_LIST_ID: "12", SABY_PRICE_UNIT: "rubles" };
    const data = await previewCatalogue("saby", env, 0, async (url, options) => {
      assert.equal(new URL(url).searchParams.get("pointId"), "7"); assert.equal(options.headers["X-SBISAccessToken"], "verification-token");
      return Response.json({ outcome: true, nomenclatures: [{ isParent: true, name: "Папка", hierarchicalId: 1 }, { externalId: "part-1", article: "0002", name: "Свеча", cost: 450.25, balance: "3", hierarchicalId: 20 }] });
    });
    assert.equal(data.rows.length, 1); assert.equal(data.rows[0].code, "0002"); assert.equal(data.rows[0].priceCents, 45025); assert.equal(data.nextCursor, 20);
    await assert.rejects(() => previewCatalogue("saby", env, 0, async () => Response.json({ unexpected: [] })), /Формат ответа/);
  });
  await check("Несколько прайсов объединяются, артикулы и источники сохраняются", async () => {
    await importPrice(priceRows); await importPrice([priceRows[0]], "Поставщик №1", "supplier");
    const results = await api("/api/products?q=001-A");
    assert.equal(results.data.items.length, 2);
    product = results.data.items.find(x => x.sourceType === "warehouse");
    assert.equal(product.code, "001-A"); assert.equal(product.stock, 5);
    assert.equal((await api("/api/products?source=supplier")).data.items.length, 1);
  });
  if (!product) throw new Error("Импорт прайса не прошёл; зависимые проверки остановлены.");
  await check("Фото загружается администратором и появляется в галерее и каталоге клиента", async () => {
    const created = await uploadPhoto(product.id);
    assert.equal(created.status, 201, JSON.stringify(created.data)); savedPhoto = created.data.photo;
    const gallery = await api("/api/products/" + product.id + "/photos", { user: client });
    assert.equal(gallery.status, 200); assert.equal(gallery.data.photos[0].id, savedPhoto.id);
    const offer = (await api("/api/products?q=001-A", { user: client })).data.items.find(p => p.id === product.id);
    assert.equal(offer.photoUrl, savedPhoto.url); assert.equal(offer.photoCount, 1);
    const response = await runtime.dispatchFetch("http://app.atoll.test" + savedPhoto.url);
    assert.equal(response.status, 200); assert.equal(response.headers.get("content-type"), "image/png");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), photoBytes);
  });
  await check("Фото защищено от клиента, SVG, подмены MIME, больших и повреждённых файлов", async () => {
    assert.equal((await uploadPhoto(product.id, photoBytes, client)).status, 403);
    assert.equal((await uploadPhoto(product.id, photoBytes, null)).status, 403);
    for (const bytes of [new TextEncoder().encode('<svg onload="alert(1)"/>'), new TextEncoder().encode('<html>not a photo</html>'), photoBytes.slice(0, 30)]) assert.equal((await uploadPhoto(product.id, bytes)).status, 400);
    const corruptPng = photoBytes.slice(); corruptPng[corruptPng.length - 1] ^= 1;
    assert.equal((await uploadPhoto(product.id, corruptPng)).status, 400);
    assert.equal((await uploadPhoto(product.id, new Uint8Array(3_000_001))).status, 413);
    const huge = await sharp({ create: { width: 8000, height: 1, channels: 3, background: '#447799' } }).png().toBuffer();
    const oversized = await uploadPhoto(product.id, huge); assert.equal(oversized.status, 400); assert.match(oversized.data.error, /6000/);
    const tooManyPixels = await sharp({ create: { width: 5000, height: 5000, channels: 3, background: '#447799' } }).png().toBuffer();
    const pixels = await uploadPhoto(product.id, tooManyPixels); assert.equal(pixels.status, 400); assert.match(pixels.data.error, /24 мегапикселей/);
    assert.equal((await uploadPhoto("missing-product")).status, 404);
    assert.equal((await api("/api/products/" + product.id + "/photos/" + savedPhoto.id, { user: client, method: "DELETE" })).status, 403);
    assert.equal((await api("/api/products/" + product.id + "/photos")).data.photos.length, 1);
  });
  await check("JPEG и оба вида WebP распознаются по содержимому с правильными размерами", async () => {
    const source = sharp({ create: { width: 16, height: 12, channels: 3, background: '#447799' } });
    for (const [bytes, type] of [[await source.clone().jpeg().toBuffer(), 'image/jpeg'], [await source.clone().webp().toBuffer(), 'image/webp'], [await source.clone().webp({ lossless: true }).toBuffer(), 'image/webp']]) {
      const form = new FormData(); form.set('file', new Blob([bytes], { type: 'application/octet-stream' }), 'unknown.bin');
      const uploaded = await api('/api/products/' + product.id + '/photos', { method: 'POST', body: form });
      assert.equal(uploaded.status, 201, JSON.stringify(uploaded.data)); assert.equal(uploaded.data.photo.width, 16); assert.equal(uploaded.data.photo.height, 12);
      const response = await runtime.dispatchFetch('http://app.atoll.test' + uploaded.data.photo.url);
      assert.equal(response.headers.get('content-type'), type); assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array(bytes));
      assert.equal((await api('/api/products/' + product.id + '/photos/' + uploaded.data.photo.id, { method: 'DELETE' })).status, 200);
    }
  });
  await check("Две одновременные загрузки пятого фото не превышают лимит и не оставляют лишний файл", async () => {
    for (let n = 0; n < 3; n++) assert.equal((await uploadPhoto(product.id)).status, 201);
    const results = await Promise.all([uploadPhoto(product.id), uploadPhoto(product.id)]);
    assert.deepEqual(results.map(r => r.status).sort(), [201, 409]);
    assert.equal((await uploadPhoto(product.id)).status, 409);
    const gallery = (await api('/api/products/' + product.id + '/photos')).data.photos;
    assert.equal(gallery.length, 5);
    const bucket = await runtime.getR2Bucket('BUCKET');
    assert.equal((await bucket.list({ prefix: 'product-photos/' })).objects.length, 5);
    for (const photo of gallery.filter(x => x.id !== savedPhoto.id)) {
      assert.equal((await api('/api/products/' + product.id + '/photos/' + photo.id, { method: 'DELETE' })).status, 200);
      assert.equal((await api('/api/products/' + product.id + '/photos/' + photo.id, { method: 'DELETE' })).status, 200);
      assert.equal((await runtime.dispatchFetch('http://app.atoll.test' + photo.url)).status, 404);
    }
    assert.equal((await bucket.list({ prefix: 'product-photos/' })).objects.length, 1);
  });
  await check("Отключение поставщика скрывает его фото у клиента, сохраняя доступ администратора", async () => {
    const supplier = (await api('/api/suppliers')).data.suppliers.find(s => s.name === 'Поставщик №1');
    const goods = (await api('/api/products?q=001-A')).data.items.find(p => p.sourceType === 'supplier');
    const created = await uploadPhoto(goods.id); assert.equal(created.status, 201);
    const disable = await api('/api/suppliers/' + supplier.id, { method: 'PATCH', body: { enabled: false, expectedRevision: supplier.revision } }); assert.equal(disable.status, 200);
    assert.equal((await api('/api/products/' + goods.id + '/photos', { user: client })).status, 404);
    assert.equal((await runtime.dispatchFetch('http://app.atoll.test' + created.data.photo.url)).status, 404);
    assert.equal((await api('/api/products/' + goods.id + '/photos')).data.photos.length, 1);
    const adminRead = await runtime.dispatchFetch('http://app.atoll.test' + created.data.photo.url, { headers: { 'x-test-user': owner.id, 'x-test-email': owner.email } }); assert.equal(adminRead.status, 200);
    assert.equal((await api('/api/suppliers/' + supplier.id, { method: 'PATCH', body: { enabled: true, expectedRevision: disable.data.supplier.revision } })).status, 200);
    assert.equal((await runtime.dispatchFetch('http://app.atoll.test' + created.data.photo.url)).status, 200);
  });
  await check("Индивидуальная наценка 25% даёт 125 рублей и защищена от клиента", async () => {
    assert.equal((await api("/api/customers/" + customerId, { method: "PATCH", body: { markupBps: 2500 } })).status, 200);
    const offers = await api("/api/products?q=001-A", { user: client });
    assert.equal(offers.data.items.find(x => x.id === product.id).priceCents, 12500);
    assert.equal((await api("/api/customers/" + adminId, { user: client, method: "PATCH", body: { markupBps: 0 } })).status, 403);
  });
  await check("Недостаточный остаток не создаёт заказ и не списывает товар", async () => {
    const rejected = await api("/api/orders", { user: client, method: "POST", body: { idempotencyKey: "too-many", items: [{ productId: product.id, quantity: 6 }] } });
    assert.equal(rejected.status, 409);
    assert.equal((await api("/api/products?q=001-A")).data.items.find(x => x.id === product.id).stock, 5);
  });
  await check("Повтор заказа не резервирует и не списывает товар второй раз", async () => {
    const body = { idempotencyKey: "checkout-1", items: [{ productId: product.id, quantity: 2, expectedPriceCents: 12500 }] };
    const first = await api("/api/orders", { user: client, method: "POST", body });
    assert.equal(first.status, 201, JSON.stringify(first.data)); order = first.data.order;
    const repeat = await api("/api/orders", { user: client, method: "POST", body });
    assert.equal(repeat.data.order.id, order.id); assert.equal(order.total_cents, 25000);
    assert.equal((await api("/api/products?q=001-A")).data.items.find(x => x.id === product.id).stock, 3);
    assert.equal((await api("/api/orders", { user: other })).data.orders.length, 0);
  });
  await check("Отмена дважды возвращает остаток один раз и записывается в журнал", async () => {
    for (let n = 0; n < 2; n++) assert.equal((await api("/api/orders/" + order.id, { method: "PATCH", body: { status: "cancelled" } })).status, 200);
    assert.equal((await api("/api/products?q=001-A")).data.items.find(x => x.id === product.id).stock, 5);
    const movements = (await api("/api/movements")).data.movements;
    assert.equal(movements.filter(x => x.kind === "return" && x.reference_id === order.id).length, 1);
  });
  await check("Подтверждение перевода дважды зачисляет деньги один раз", async () => {
    const request = await api("/api/wallet", { user: client, method: "POST", body: { amountCents: 30000, reference: "Тестовый перевод" } });
    for (let n = 0; n < 2; n++) assert.equal((await api("/api/wallet/" + request.data.id, { method: "PATCH", body: { action: "approve" } })).status, 200);
    assert.equal((await api("/api/wallet", { user: client })).data.balanceCents, 30000);
  });
  await check("Две одновременные покупки последней детали не дают отрицательный остаток", async () => {
    const last = (await api("/api/products?q=002-B")).data.items[0];
    const results = await Promise.all(["last-1", "last-2"].map(idempotencyKey => api("/api/orders", { user: client, method: "POST", body: { idempotencyKey, items: [{ productId: last.id, quantity: 1 }] } })));
    assert.deepEqual(results.map(x => x.status).sort(), [201, 409]);
    assert.equal((await api("/api/products?q=002-B")).data.items[0].stock, 0);
  });
  await check("Оплата с баланса и повторная отмена сохраняют правильную сумму", async () => {
    const paid = await api("/api/orders", { user: client, method: "POST", body: { idempotencyKey: "paid", payFromBalance: true, items: [{ productId: product.id, quantity: 1 }] } });
    assert.equal(paid.status, 201); assert.equal((await api("/api/wallet", { user: client })).data.balanceCents, 17500);
    for (let n = 0; n < 2; n++) await api("/api/orders/" + paid.data.order.id, { method: "PATCH", body: { status: "cancelled" } });
    assert.equal((await api("/api/wallet", { user: client })).data.balanceCents, 30000);
  });
  await check("Продажа с прилавка сразу возвращает статус «Завершён»", async () => {
    const sale = await api("/api/orders", { method: "POST", body: { idempotencyKey: "pos-sale", channel: "pos", items: [{ productId: product.id, quantity: 1 }] } });
    assert.equal(sale.status, 201); assert.equal(sale.data.order.status, "completed");
    saleId = sale.data.order.id;
    assert.equal((await api("/api/orders/" + sale.data.order.id, { method: "PATCH", body: { status: "cancelled" } })).status, 409);
  });
  await check("VIN-заявка сохраняется, неверный VIN отклоняется", async () => {
    assert.equal((await api("/api/vin", { user: client, method: "POST", body: { vin: "WF04XXGBB45G42871", details: "Дроссельная заслонка" } })).status, 201);
    assert.equal((await api("/api/vin", { user: client, method: "POST", body: { vin: "INVALID", details: "Деталь" } })).status, 400);
    assert.equal((await api("/api/vin", { user: client })).data.requests[0].vin, "WF04XXGBB45G42871");
  });
  await check("Завершённую продажу нельзя открыть повторно и затем отменить", async () => {
    assert.equal((await api("/api/orders/" + saleId, { method: "PATCH", body: { status: "new" } })).status, 409);
  });
  await check("Обновление физического остатка сохраняет резервы и привязку товара", async () => {
    const reserve = await api("/api/orders", { user: client, method: "POST", body: { idempotencyKey: "weekly-price", items: [{ productId: product.id, quantity: 1 }] } });
    assert.equal(reserve.status, 201);
    await importPrice([{ ...priceRows[0], priceCents: 12000, stock: 10 }, priceRows[1]], "Основной склад", "warehouse", "physical");
    const updated = (await api("/api/products?q=001-A")).data.items.find(x => x.sourceType === "warehouse");
    assert.equal(updated.id, product.id); assert.equal(updated.stock, 9); assert.equal(updated.priceCents, 12000);
    assert.equal(updated.photoUrl, savedPhoto.url); assert.equal(updated.photoCount, 1);
    const oldOrder = (await api("/api/orders", { user: client })).data.orders.find(x => x.id === reserve.data.order.id);
    assert.equal(oldOrder.items[0].unit_price_cents, 12500);
    await api("/api/orders/" + oldOrder.id, { method: "PATCH", body: { status: "cancelled" } });
    assert.equal((await api("/api/products?q=001-A")).data.items.find(x => x.id === product.id).stock, 10);
  });
  await check("Товар можно добавить вручную с ячейкой без Excel", async () => {
    const added = await api("/api/products", { method: "POST", body: { code: "003-C", brand: "TEST", name: "Прокладка", stock: 6, priceCents: 4500, sourceName: "Основной склад", warehouse: "Основной склад", bin: "Б-2", minStock: 2 } });
    assert.equal(added.status, 201, JSON.stringify(added.data));
    const goods = (await api("/api/products?q=003-C")).data.items;
    assert.equal(goods.length, 1); assert.equal(goods[0].stock, 6); assert.equal(goods[0].bin, "Б-2");
    assert.equal((await api("/api/products", { user: client, method: "POST", body: {} })).status, 403);
  });
  await check("Некорректный физический остаток отклоняет весь прайс без изменений", async () => {
    const reserved = await api("/api/orders", { user: client, method: "POST", body: { idempotencyKey: "invalid-physical", items: [{ productId: product.id, quantity: 2 }] } });
    assert.equal(reserved.status, 201);
    const before = (await api("/api/products?q=001-A")).data;
    await importPrice([{ ...priceRows[0], stock: 1, priceCents: 99000 }], "Основной склад", "warehouse", "physical", 409);
    assert.deepEqual((await api("/api/products?q=001-A")).data, before);
    await api("/api/orders/" + reserved.data.order.id, { method: "PATCH", body: { status: "cancelled" } });
  });
  await check("Прайс на 10 000 позиций укладывается в 50 запросов D1", async () => {
    const rows = Array.from({ length: 10000 }, (_, i) => ({ code: "BULK-" + String(i).padStart(5, "0"), brand: "LOAD", name: "Деталь " + i, priceCents: i ? 100 : 16000, stock: 2 }));
    const result = await importPrice(rows, "Нагрузочный прайс", "supplier");
    assert.ok(result.queries <= 50);
    assert.equal((await api("/api/products?q=BULK-")).data.total, 10000);
  });
  await check("Корзина из 80 товаров и её отмена укладываются в лимит D1", async () => {
    const rows = [...(await api("/api/products?q=BULK-")).data.items, ...(await api("/api/products?q=BULK-&page=1")).data.items].slice(0, 80);
    const placed = await api("/api/orders", { user: client, method: "POST", body: { idempotencyKey: "bulk-checkout", items: rows.map(x => ({ productId: x.id, quantity: 1 })) } });
    assert.equal(placed.status, 201, JSON.stringify(placed.data)); assert.ok(placed.queries <= 50);
    const orders = await api("/api/orders", { user: client }); assert.ok(orders.queries <= 50);
    assert.equal(orders.data.orders.find(x => x.id === placed.data.order.id).items.length, 80);
    const cancelled = await api("/api/orders/" + placed.data.order.id, { method: "PATCH", body: { status: "cancelled" } });
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.data)); assert.ok(cancelled.queries <= 50);
    assert.equal((await api("/api/products?q=BULK-00000")).data.items[0].stock, 2);
  });
  await check("Одновременные оплаты не позволяют потратить один баланс дважды", async () => {
    const goods = (await api("/api/products?q=BULK-00000")).data.items[0];
    const results = await Promise.all(["funds-1", "funds-2"].map(idempotencyKey => api("/api/orders", { user: client, method: "POST", body: { idempotencyKey, payFromBalance: true, items: [{ productId: goods.id, quantity: 1 }] } })));
    assert.deepEqual(results.map(x => x.status).sort(), [201, 409]);
    assert.equal((await api("/api/wallet", { user: client })).data.balanceCents, 10000);
    await api("/api/orders/" + results.find(x => x.status === 201).data.order.id, { method: "PATCH", body: { status: "cancelled" } });
    assert.equal((await api("/api/wallet", { user: client })).data.balanceCents, 30000);
  });
  await check("Закупки защищены от клиента и неверных строк", async () => {
    assert.equal((await api("/api/purchase-orders", { user: client })).status, 403);
    assert.equal((await api("/api/purchase-orders", { user: null })).status, 403);
    assert.equal((await api("/api/purchase-orders", { method: "POST", body: { idempotencyKey: "bad-purchase", items: [null] } })).status, 400);
  });
  await check("Проценка выбирает достаточное наличие и учитывает уже запланированную закупку", async () => {
    for (const [code, minimum] of [["PO-1", 5], ["PO-2", 3]]) {
      const created = await api("/api/products", { method: "POST", body: { code, brand: "PARTS", name: "Закупочная деталь " + code, priceCents: 15000, stock: 0, sourceName: "Склад закупки", warehouse: "Склад закупки", bin: "A-1", minStock: minimum } });
      assert.equal(created.status, 201, JSON.stringify(created.data));
    }
    await importPrice([{ code: "PO-1", brand: "PARTS", name: "Мало товара", priceCents: 4000, stock: 4 }], "Дешёвый поставщик", "supplier");
    await importPrice([{ code: "PO-1", brand: "PARTS", name: "Деталь 1", priceCents: 7000, stock: 50 }, { code: "PO-2", brand: "PARTS", name: "Деталь 2", priceCents: 8000, stock: 50 }], "Снабжение", "supplier");
    const needs = (await api("/api/purchasing")).data.needs.filter(n => n.product.code.startsWith("PO-"));
    assert.equal(needs.length, 2); assert.ok(needs.every(n => n.recommendedId));
    assert.equal(needs[0].offers.find(o => o.id === needs[0].recommendedId).sourceName, "Снабжение");
    const payload = { idempotencyKey: "first-purchase", items: needs.map(n => ({ warehouseProductId: n.product.id, supplierProductId: n.recommendedId, quantity: n.quantity })) };
    const made = await api("/api/purchase-orders", { method: "POST", body: payload });
    assert.equal(made.status, 201, JSON.stringify(made.data)); assert.ok(made.queries < 50);
    purchase = (await api("/api/purchase-orders")).data.orders.find(o => o.id === made.data.orders[0].id);
    purchaseGoods = needs.map(n => n.product);
    assert.equal(purchase.total_cents, 59000); assert.equal(purchase.status, "draft");
    const repeated = await api("/api/purchase-orders", { method: "POST", body: payload });
    assert.equal(repeated.status, 200); assert.equal(repeated.data.repeated, true); assert.equal(repeated.data.orders[0].id, purchase.id);
    assert.equal((await api("/api/purchase-orders", { method: "POST", body: { ...payload, idempotencyKey: "duplicate-demand" } })).status, 409);
    assert.ok((await api("/api/purchasing")).data.needs.filter(n => n.product.code.startsWith("PO-")).every(n => n.quantity === 0 && n.incomingQty > 0));
  });
  await check("Закупочная цена сохраняется после обновления прайса поставщика", async () => {
    await importPrice([{ code: "PO-1", brand: "PARTS", name: "Новая цена", priceCents: 9000, stock: 50 }, { code: "PO-2", brand: "PARTS", name: "Новая цена 2", priceCents: 9500, stock: 50 }], "Снабжение", "supplier");
    const saved = (await api("/api/purchase-orders")).data.orders.find(o => o.id === purchase.id);
    assert.equal(saved.total_cents, 59000); assert.equal(saved.items.find(i => i.code === "PO-1").unit_cost_cents, 7000);
    assert.equal((await api("/api/purchase-orders/" + purchase.id + "/receive", { method: "POST", body: { idempotencyKey: "draft-receipt", items: [{ itemId: purchase.items[0].id, quantity: 1 }] } })).status, 409);
    assert.equal((await api("/api/purchase-orders/" + purchase.id, { method: "PATCH", body: { status: "ordered" } })).status, 200);
  });
  await check("Частичная приёмка и её повтор увеличивают складской остаток один раз", async () => {
    const first = purchase.items.find(i => i.code === "PO-1"), second = purchase.items.find(i => i.code === "PO-2");
    const payload = { idempotencyKey: "partial-receipt", items: [{ itemId: first.id, quantity: 3 }, { itemId: second.id, quantity: 1 }] };
    assert.equal((await api("/api/purchase-orders/" + purchase.id + "/receive", { method: "POST", body: payload })).status, 201);
    const repeated = await api("/api/purchase-orders/" + purchase.id + "/receive", { method: "POST", body: payload });
    assert.equal(repeated.status, 200); assert.equal(repeated.data.repeated, true);
    const saved = (await api("/api/purchase-orders")).data.orders.find(o => o.id === purchase.id);
    assert.equal(saved.status, "partial"); assert.equal(saved.items.find(i => i.id === first.id).received_qty, 3);
    assert.equal((await api("/api/products?q=PO-1&source=warehouse")).data.items[0].stock, 3);
    assert.equal((await api("/api/purchase-orders/" + purchase.id, { method: "PATCH", body: { status: "cancelled" } })).status, 409);
    assert.equal((await api("/api/purchase-orders/" + purchase.id + "/receive", { method: "POST", body: { idempotencyKey: "over-receipt", items: [{ itemId: first.id, quantity: 3 }] } })).status, 409);
  });
  await check("Две конкурентные приёмки оставшихся деталей дают одно поступление", async () => {
    const first = purchase.items.find(i => i.code === "PO-1"), second = purchase.items.find(i => i.code === "PO-2");
    const results = await Promise.all(["race-receipt-1", "race-receipt-2"].map(idempotencyKey => api("/api/purchase-orders/" + purchase.id + "/receive", { method: "POST", body: { idempotencyKey, items: [{ itemId: first.id, quantity: 2 }] } })));
    assert.deepEqual(results.map(r => r.status).sort(), [201, 409]);
    assert.equal((await api("/api/products?q=PO-1&source=warehouse")).data.items[0].stock, 5);
    const finish = await api("/api/purchase-orders/" + purchase.id + "/receive", { method: "POST", body: { idempotencyKey: "finish-receipt", items: [{ itemId: second.id, quantity: 2 }] } });
    assert.equal(finish.status, 201, JSON.stringify(finish.data));
    assert.equal((await api("/api/purchase-orders")).data.orders.find(o => o.id === purchase.id).status, "received");
    const movements = (await api("/api/movements")).data.movements.filter(m => m.kind === "purchase_receipt");
    assert.equal(movements.filter(m => m.code === "PO-1").reduce((sum, m) => sum + m.delta, 0), 5);
  });
  await check("Конкурентные закупки разных складов не превышают остаток поставщика", async () => {
    for (const sourceName of ["Первый склад", "Второй склад"]) assert.equal((await api("/api/products", { method: "POST", body: { code: "PO-RACE", brand: "PARTS", name: "Общий товар", priceCents: 500, stock: 0, sourceName, minStock: 5 } })).status, 201);
    await importPrice([{ code: "PO-RACE", brand: "PARTS", name: "Общий товар", priceCents: 300, stock: 5 }], "Последний остаток", "supplier");
    const needs = (await api("/api/purchasing")).data.needs.filter(n => n.product.code === "PO-RACE");
    const results = await Promise.all(needs.map((n, index) => api("/api/purchase-orders", { method: "POST", body: { idempotencyKey: "supplier-race-" + index, items: [{ warehouseProductId: n.product.id, supplierProductId: n.recommendedId, quantity: 5 }] } })));
    assert.deepEqual(results.map(r => r.status).sort(), [201, 409]);
    const saved = results.find(r => r.status === 201).data.orders[0];
    assert.equal((await api("/api/purchase-orders/" + saved.id, { method: "PATCH", body: { status: "cancelled" } })).status, 200);
    assert.ok((await api("/api/purchasing")).data.needs.filter(n => n.product.code === "PO-RACE").every(n => n.incomingQty === 0));
  });
  await check("После перезагрузки сохраняется ключ незавершённой приёмки", async () => {
    const values = new Map(), storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
    const payload = { items: [{ itemId: "line-1", quantity: 2 }] };
    const first = await mutationAttempt("receive:owner:purchase", payload, storage);
    const reloaded = pendingMutation("receive:owner:purchase", storage);
    assert.equal((await mutationAttempt("receive:owner:purchase", payload, storage)).key, first.key);
    assert.deepEqual(reloaded.payload, payload); completeMutation(reloaded, storage); assert.equal(pendingMutation("receive:owner:purchase", storage), null);
  });
  await check("Переименование поставщика сохраняет товар, независимые прайсы и историю закупок", async () => {
    const first = (await api("/api/suppliers", { method: "POST", body: { name: "Переименуемый", connectionType: "both", email: "contact@atoll.test", leadDays: 2 } })).data.supplier;
    const second = (await api("/api/suppliers", { method: "POST", body: { name: "Соседний поставщик" } })).data.supplier;
    const row = { code: "SUP-MANUAL", brand: "TEST", name: "Деталь поставщика", priceCents: 1000, stock: 5 };
    await importPrice([row], first.name, "supplier", "available", 200, first.id); await importPrice([{ ...row, priceCents: 1500 }], second.name, "supplier", "available", 200, second.id);
    const offers = (await api("/api/products?q=SUP-MANUAL")).data.items, firstOffer = offers.find(p => p.sourceName === first.name), secondOffer = offers.find(p => p.sourceName === second.name);
    const target = await api("/api/products", { method: "POST", body: { ...row, stock: 0, minStock: 2, sourceName: "Склад для справочника" } }); assert.equal(target.status, 201);
    const procurement = await api("/api/purchase-orders", { method: "POST", body: { idempotencyKey: "supplier-document", items: [{ warehouseProductId: target.data.id, supplierProductId: firstOffer.id, quantity: 2 }] } }); assert.equal(procurement.status, 201, JSON.stringify(procurement.data));
    const customerOrder = await api("/api/orders", { user: client, method: "POST", body: { idempotencyKey: "supplier-history", items: [{ productId: firstOffer.id, quantity: 1 }] } }); assert.equal(customerOrder.status, 201);
    const renamed = await api("/api/suppliers/" + first.id, { method: "PATCH", body: { name: "Новое название", expectedRevision: first.revision } }); assert.equal(renamed.status, 200); assert.equal(renamed.data.supplier.email, "contact@atoll.test");
    assert.equal((await api("/api/suppliers/" + first.id, { method: "PATCH", body: { leadDays: 10, expectedRevision: first.revision } })).status, 409);
    await importPrice([{ ...row, priceCents: 1200 }], "Старое название игнорируется при выборе ID", "supplier", "available", 200, first.id);
    const current = (await api("/api/products?q=SUP-MANUAL")).data.items;
    assert.equal(current.find(p => p.id === firstOffer.id).basePriceCents, 1200); assert.equal(current.find(p => p.id === firstOffer.id).sourceName, "Новое название"); assert.equal(current.find(p => p.id === secondOffer.id).basePriceCents, 1500);
    assert.equal((await api("/api/orders")).data.orders.find(o => o.id === customerOrder.data.order.id).items[0].source_name, first.name);
    assert.equal((await api("/api/purchase-orders")).data.orders.find(o => o.id === procurement.data.orders[0].id).supplier_name, first.name);
    const disabled = await api("/api/suppliers/" + first.id, { method: "PATCH", body: { enabled: false, expectedRevision: renamed.data.supplier.revision } }); assert.equal(disabled.status, 200);
    assert.ok(!(await api("/api/products?q=SUP-MANUAL", { user: client })).data.items.some(p => p.id === firstOffer.id));
    assert.equal((await api("/api/orders", { user: client, method: "POST", body: { idempotencyKey: "disabled-supplier", items: [{ productId: firstOffer.id, quantity: 1 }] } })).status, 409);
    assert.ok((await api("/api/purchasing")).data.needs.every(n => !n.offers.some(p => p.id === firstOffer.id)));
    await importPrice([row], first.name, "supplier", "available", 409, first.id);
    const enabled = await api("/api/suppliers/" + first.id, { method: "PATCH", body: { enabled: true, expectedRevision: disabled.data.supplier.revision } }); assert.equal(enabled.status, 200);
    assert.ok((await api("/api/products?q=SUP-MANUAL")).data.items.some(p => p.id === firstOffer.id));
  });
  await check("API-поставщик не принимает прайс, а параллельное редактирование не теряет изменения", async () => {
    const supplier = (await api("/api/suppliers")).data.suppliers.find(s => s.name === "Ручной API-поставщик");
    await importPrice([priceRows[0]], supplier.name, "supplier", "available", 409, supplier.id);
    const results = await Promise.all([4, 7].map(leadDays => api("/api/suppliers/" + supplier.id, { method: "PATCH", body: { leadDays, expectedRevision: supplier.revision } })));
    assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
    const current = (await api("/api/suppliers")).data.suppliers.find(s => s.id === supplier.id);
    assert.equal(current.revision, supplier.revision + 1); assert.equal(current.lead_days, results.find(r => r.status === 200).data.supplier.lead_days);
  });
  await check("Данные, закупки, приёмки и файлы восстанавливаются в новую D1", async () => {
    const backup = (await api("/api/backup")).data;
    assert.equal(backup.version, 4); assert.ok(backup.product_photos.length > 0);
    const restoredOwner = await api("/api/me", { restore: true }); assert.equal(restoredOwner.data.user.role, "admin");
    const raw = JSON.stringify(backup), parts = { "backup.json": new TextEncoder().encode(raw) };
    const form = new FormData(); form.set("data", raw);
    const bucket = await runtime.getR2Bucket("BUCKET");
    for (const record of backup.imports) if (record.file_key) { const bytes = new Uint8Array(await (await bucket.get(record.file_key)).arrayBuffer()); form.set("file:" + record.id, new Blob([bytes]), record.filename); parts["files/" + record.id] = bytes; }
    for (const record of backup.product_photos) { const bytes = new Uint8Array(await (await bucket.get(record.file_key)).arrayBuffer()); form.set("photo:" + record.id, new Blob([bytes]), record.filename); parts["photos/" + record.id] = bytes; }
    const manifest = JSON.stringify(await createBackupManifest(parts)); form.set("manifest", manifest);
    const altered = new FormData(); altered.set("data", raw.replace('"version":4', '"version":1')); altered.set("manifest", manifest);
    const rejected = await api("/api/restore", { restore: true, method: "POST", body: altered });
    assert.equal(rejected.status, 400); assert.match(rejected.data.error, /Контрольная сумма/);
    const corruptFile = new FormData(); for (const [name, value] of form.entries()) corruptFile.set(name, value);
    const firstFile = backup.imports.find(record => record.file_key);
    corruptFile.set("file:" + firstFile.id, new Blob(["Повреждённый файл"]), firstFile.filename);
    const badFile = await api("/api/restore", { restore: true, method: "POST", body: corruptFile });
    assert.equal(badFile.status, 400); assert.match(badFile.data.error, /Контрольная сумма/);
    const missingPhoto = new FormData(); for (const [name, value] of form.entries()) missingPhoto.set(name, value);
    missingPhoto.delete('photo:' + backup.product_photos[0].id);
    assert.equal((await api('/api/restore', { restore: true, method: 'POST', body: missingPhoto })).status, 400);
    const corruptPhoto = new FormData(); for (const [name, value] of form.entries()) corruptPhoto.set(name, value);
    const corruptBytes = parts['photos/' + backup.product_photos[0].id].slice(); corruptBytes[corruptBytes.length - 1] ^= 1;
    corruptPhoto.set('photo:' + backup.product_photos[0].id, new Blob([corruptBytes]), 'damaged.png');
    const badPhoto = await api('/api/restore', { restore: true, method: 'POST', body: corruptPhoto });
    assert.equal(badPhoto.status, 400); assert.match(badPhoto.data.error, /Контрольная сумма/);
    assert.equal((await runtime.getD1Database('RESTORE_DB').then(db => db.prepare('SELECT COUNT(*) AS n FROM product_photos').first())).n, 0);
    const restore = await api("/api/restore", { restore: true, method: "POST", body: form });
    assert.equal(restore.status, 200, JSON.stringify(restore.data));
    const copied = (await api("/api/backup", { restore: true })).data;
    assert.equal(copied.products.length, backup.products.length); assert.equal(copied.orders.length, backup.orders.length);
    assert.deepEqual(copied.orders.map(x => x.total_cents).sort(), backup.orders.map(x => x.total_cents).sort());
    assert.deepEqual(copied.purchase_orders, backup.purchase_orders); assert.deepEqual(copied.purchase_receipt_items, backup.purchase_receipt_items);
    assert.deepEqual(copied.suppliers, backup.suppliers); assert.equal((await api("/api/shop-settings", { restore: true })).data.orderEmail, "orders@atoll.test");
    const metadata = rows => rows.map(({ file_key, ...row }) => row).sort((a,b) => a.id.localeCompare(b.id));
    assert.deepEqual(metadata(copied.product_photos), metadata(backup.product_photos));
    for (const record of copied.product_photos) {
      const restoredBytes = new Uint8Array(await (await bucket.get(record.file_key)).arrayBuffer());
      assert.deepEqual(restoredBytes, parts['photos/' + record.id]);
    }
    assert.equal((await api("/api/wallet", { restore: true, user: client })).data.balanceCents, 30000);
    assert.equal((await api("/api/restore", { restore: true, method: "POST", body: form })).status, 409);
    parts["manifest.json"] = new TextEncoder().encode(manifest);
    await writeFile(join(directory, "verified-backup.zip"), zipSync(parts));
    await writeFile(join(directory, "expected-backup.json"), raw);
  });
  await check("Копия восстанавливается в обычную SQLite с файлами и не перезаписывает каталог", async () => {
    const target = join(directory, "portable-restore");
    const result = spawnSync("python3", ["scripts/restore-sqlite.py", join(directory, "verified-backup.zip"), target], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr); const report = JSON.parse(result.stdout); assert.equal(report.checksumsVerified, true);
    const original = JSON.parse(await readFile(join(directory, "expected-backup.json"), "utf8"));
    for (const [table, count] of Object.entries(report.counts)) assert.equal(count, original[table].length, table);
    const compared = spawnSync("python3", ["-c", "import json,sqlite3,sys,pathlib,hashlib,zipfile; c=sqlite3.connect(sys.argv[1]); d=json.load(open(sys.argv[2])); c.row_factory=sqlite3.Row; tables=['products','orders','order_items','ledger','purchase_order_items','purchase_receipt_items']; actual={t:[dict(r) for r in c.execute('SELECT * FROM '+t)] for t in tables}; assert all(sorted(actual[t],key=lambda r:r['id'])==sorted(d[t],key=lambda r:r['id']) for t in tables); assert c.execute('PRAGMA foreign_key_check').fetchall()==[]; archive=zipfile.ZipFile(sys.argv[3]); directory=pathlib.Path(sys.argv[1]).parent; assert all((directory/r['file_key']).read_bytes()==archive.read('files/'+r['id']) for r in c.execute('SELECT id,file_key FROM imports WHERE file_key IS NOT NULL')); assert all((directory/r['file_key']).read_bytes()==archive.read('photos/'+r['id']) for r in c.execute('SELECT id,file_key FROM product_photos')); print('identical business rows, prices and photos')", join(target, "inventory.db"), join(directory, "expected-backup.json"), join(directory, "verified-backup.zip")], { encoding: "utf8" });
    assert.equal(compared.status, 0, compared.stderr);
    const repeated = spawnSync("python3", ["scripts/restore-sqlite.py", join(directory, "verified-backup.zip"), target], { cwd: root, encoding: "utf8" });
    assert.equal(repeated.status, 1); assert.match(repeated.stderr, /already exists/);
  });
  await check("Копия версии 2 без справочника восстанавливается в D1 и SQLite, затем поставщики связываются", async () => {
    const backup = JSON.parse(await readFile(join(directory, "expected-backup.json"), "utf8"));
    backup.version = 2; delete backup.suppliers; delete backup.product_photos;
    const imports = new Map(backup.imports.map(i => [i.id, i]));
    for (const setting of backup.settings) {
      const record = imports.get(setting.value);
      if (setting.key.startsWith("active_import:") && record?.source_type === "supplier") setting.key = "active_import:supplier:" + record.source_name.normalize("NFKC").toLocaleLowerCase("ru-RU").replace(/\s+/g, " ").trim();
    }
    for (const record of backup.imports) delete record.supplier_id;
    const parts = unzipSync(new Uint8Array(await readFile(join(directory, "verified-backup.zip")))); delete parts["manifest.json"];
    for (const name of Object.keys(parts)) if (name.startsWith('photos/')) delete parts[name];
    const raw = JSON.stringify(backup); parts["backup.json"] = new TextEncoder().encode(raw);
    const manifest = JSON.stringify(await createBackupManifest(parts)); parts["manifest.json"] = new TextEncoder().encode(manifest);
    const form = new FormData(); form.set("data", raw); form.set("manifest", manifest);
    for (const record of backup.imports) if (record.file_key) form.set("file:" + record.id, new Blob([parts["files/" + record.id]]), record.filename);
    await api("/api/me", { restore: "legacy" });
    const restored = await api("/api/restore", { restore: "legacy", method: "POST", body: form }); assert.equal(restored.status, 200, JSON.stringify(restored.data));
    const list = await api("/api/suppliers", { restore: "legacy" }); assert.equal(list.status, 200); assert.ok(list.data.suppliers.length > 0);
    const converted = (await api("/api/backup", { restore: "legacy" })).data;
    assert.equal(converted.version, 4); assert.equal(converted.product_photos.length, 0); assert.equal(converted.products.length, backup.products.length); assert.equal(converted.orders.length, backup.orders.length);
    assert.ok(converted.imports.filter(i => i.source_type === "supplier").every(i => converted.suppliers.some(s => s.id === i.supplier_id)));
    assert.equal((await api("/api/products", { restore: "legacy" })).data.total, (await api("/api/products")).data.total);
    const path = join(directory, "legacy-backup.zip"); await writeFile(path, zipSync(parts));
    const sqlite = spawnSync("python3", ["scripts/restore-sqlite.py", path, join(directory, "legacy-portable")], { cwd: root, encoding: "utf8" }); assert.equal(sqlite.status, 0, sqlite.stderr);
    assert.equal(JSON.parse(sqlite.stdout).sourceVersion, 2);
  });
  await check("Копии версий 1 и 3 без фотографий восстанавливаются в D1 и SQLite", async () => {
    for (const version of [1, 3]) {
      const backup = JSON.parse(await readFile(join(directory, 'expected-backup.json'), 'utf8'));
      backup.version = version; delete backup.product_photos;
      if (version === 1) { delete backup.suppliers; for (const record of backup.imports) delete record.supplier_id; }
      const source = unzipSync(new Uint8Array(await readFile(join(directory, 'verified-backup.zip'))));
      const raw = JSON.stringify(backup), parts = { 'backup.json': new TextEncoder().encode(raw) };
      const form = new FormData(); form.set('data', raw);
      for (const record of backup.imports) if (record.file_key) { parts['files/' + record.id] = source['files/' + record.id]; form.set('file:' + record.id, new Blob([parts['files/' + record.id]]), record.filename); }
      if (version >= 2) { const manifest = JSON.stringify(await createBackupManifest(parts)); parts['manifest.json'] = new TextEncoder().encode(manifest); form.set('manifest', manifest); }
      const restoreTarget = 'v' + version;
      await api('/api/me', { restore: restoreTarget });
      const result = await api('/api/restore', { restore: restoreTarget, method: 'POST', body: form }); assert.equal(result.status, 200, JSON.stringify(result.data));
      const restored = (await api('/api/backup', { restore: restoreTarget })).data;
      assert.equal(restored.product_photos.length, 0); assert.equal(restored.products.length, backup.products.length); assert.equal(restored.orders.length, backup.orders.length);
      const path = join(directory, 'v' + version + '-backup.zip'); await writeFile(path, zipSync(parts));
      const converted = spawnSync('python3', ['scripts/restore-sqlite.py', path, join(directory, 'v' + version + '-portable')], { cwd: root, encoding: 'utf8' }); assert.equal(converted.status, 0, converted.stderr); assert.equal(JSON.parse(converted.stdout).sourceVersion, version);
    }
  });
  await check("Остатки и история переживают остановку и перезапуск Worker", async () => {
    const photosBefore = (await api("/api/products/" + product.id + "/photos")).data.photos; assert.ok(photosBefore.some(p => p.id === savedPhoto.id));
    const before = (await api("/api/products")).data;
    await runtime.dispose(); runtime = new Miniflare(options);
    assert.deepEqual((await api("/api/products")).data, before);
    assert.deepEqual((await api("/api/products/" + product.id + "/photos")).data.photos, photosBefore);
    assert.ok((await api("/api/orders")).data.orders.length >= 3);
    assert.ok((await api("/api/suppliers")).data.suppliers.length >= 15); assert.equal((await api("/api/shop-settings")).data.orderEmail, "orders@atoll.test");
  });
} catch (error) {
  console.error(error.message); if (!failed) failed++;
} finally { await runtime.dispose().catch(() => {}); }
console.log(JSON.stringify({ passed, failed }));
process.exitCode = failed ? 1 : 0;
