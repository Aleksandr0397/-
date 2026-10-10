import { InputError } from "../lib/inventory-domain";
import { inspectPhoto, maxPhotoBytes, maxProductPhotos, photoView, type PhotoRecord } from "../lib/product-photos";
import { supplierVisible } from "./suppliers";

const visibleProduct = "SELECT p.id FROM products p JOIN imports i ON i.id=p.import_id WHERE p.id=? AND p.import_id IN (SELECT value FROM settings WHERE key LIKE 'active_import:%') AND " + supplierVisible();
export const photoProjection = ",(SELECT id FROM product_photos ph WHERE ph.product_id=p.id ORDER BY ph.position LIMIT 1) AS photo_id,(SELECT COUNT(*) FROM product_photos ph WHERE ph.product_id=p.id) AS photo_count";

export async function productPhotoApi(request: Request, db: D1Database, bucket: R2Bucket | undefined, isAdmin: boolean) {
  const path = new URL(request.url).pathname.replace(/\/$/, "");
  const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
  if (/^\/api\/product-photos\/[^/]+$/.test(path) && request.method === "GET") {
    const row = await db.prepare("SELECT ph.* FROM product_photos ph WHERE ph.id=?" + (isAdmin ? "" : " AND EXISTS (" + visibleProduct.replace("p.id=?", "p.id=ph.product_id") + ")")).bind(decodeURIComponent(path.split("/")[3])).first<PhotoRecord>();
    const file = row && bucket ? await bucket.get(row.file_key) : null;
    if (!row || !file) throw new InputError("Фотография не найдена.", 404);
    return new Response(file.body, { headers: { "Content-Type": row.content_type, "Content-Length": String(row.size_bytes), "X-Content-Type-Options": "nosniff", "Cache-Control": "private, no-store", "Content-Security-Policy": "default-src 'none'; sandbox" } });
  }
  const match = path.match(/^\/api\/products\/([^/]+)\/photos(?:\/([^/]+))?$/);
  if (!match) throw new InputError("Страница не найдена.", 404);
  const productId = decodeURIComponent(match[1]), photoId = match[2] ? decodeURIComponent(match[2]) : null;
  if (request.method !== "GET" && !isAdmin) throw new InputError("Доступ только для администратора.", 403);
  const exists = await db.prepare(isAdmin ? "SELECT id FROM products WHERE id=?" : visibleProduct).bind(productId).first();
  if (!exists) throw new InputError("Товар не найден.", 404);
  if (request.method === "GET" && !photoId) {
    const rows = (await db.prepare("SELECT * FROM product_photos WHERE product_id=? ORDER BY position").bind(productId).all<PhotoRecord>()).results;
    return json({ photos: rows.map(photoView) });
  }
  if (request.method === "POST" && !photoId) {
    if (!bucket) throw new InputError("Хранилище фотографий недоступно.", 503);
    if (Number(request.headers.get("content-length")) > maxPhotoBytes + 100_000) throw new InputError("Максимальный размер фотографии — 3 МБ.", 413);
    // Bound multipart input even when a client omits Content-Length.
    const reader = request.body?.getReader(), chunks: Uint8Array[] = [];
    let received = 0;
    if (!reader) throw new InputError("Выберите фотографию.");
    while (true) {
      const part = await reader.read(); if (part.done) break;
      received += part.value.length;
      if (received > maxPhotoBytes + 100_000) { await reader.cancel(); throw new InputError("Максимальный размер фотографии — 3 МБ.", 413); }
      chunks.push(part.value);
    }
    const multipart = new Uint8Array(received); let offset = 0;
    for (const chunk of chunks) { multipart.set(chunk, offset); offset += chunk.length; }
    let form: FormData;
    try { form = await new Request(request.url, { method: "POST", headers: request.headers, body: multipart }).formData(); }
    catch { throw new InputError("Не удалось прочитать фотографию."); }
    const file = form.get("file");
    if (!(file instanceof File)) throw new InputError("Выберите фотографию.");
    if (file.size > maxPhotoBytes) throw new InputError("Максимальный размер фотографии — 3 МБ.", 413);
    const bytes = new Uint8Array(await file.arrayBuffer()), image = inspectPhoto(bytes);
    const used = (await db.prepare("SELECT position FROM product_photos WHERE product_id=?").bind(productId).all<{ position: number }>()).results;
    const position = Array.from({ length: maxProductPhotos }, (_, n) => n).find(n => !used.some(x => x.position === n));
    if (position === undefined) throw new InputError("У товара уже пять фотографий. Удалите одну перед загрузкой новой.", 409);
    const id = crypto.randomUUID(), key = "product-photos/" + id;
    const row: PhotoRecord = { id, product_id: productId, file_key: key, filename: file.name.replace(/[\x00-\x1f/\\]/g, "_").slice(0,180) || "Фото", content_type: image.contentType, size_bytes: bytes.length, width: image.width, height: image.height, position, created_at: new Date().toISOString() };
    await bucket.put(key, bytes, { httpMetadata: { contentType: row.content_type } });
    try {
      await db.prepare("INSERT INTO product_photos (id,product_id,file_key,filename,content_type,size_bytes,width,height,position,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)").bind(row.id,row.product_id,row.file_key,row.filename,row.content_type,row.size_bytes,row.width,row.height,row.position,row.created_at).run();
    } catch {
      await bucket.delete(key).catch(() => {});
      throw new InputError("Фотографии изменились во время загрузки. Обновите галерею и повторите.", 409);
    }
    return json({ photo: photoView(row) }, 201);
  }
  if (request.method === "DELETE" && photoId) {
    if (!bucket) throw new InputError("Хранилище фотографий недоступно.", 503);
    const row = await db.prepare("SELECT file_key FROM product_photos WHERE id=? AND product_id=?").bind(photoId, productId).first<{ file_key: string }>();
    if (row) {
      await db.prepare("DELETE FROM product_photos WHERE id=? AND product_id=?").bind(photoId, productId).run();
      // A leftover object after an R2 failure is harmless: no API can retrieve it.
      await bucket.delete(row.file_key).catch(() => {});
    }
    return json({ deleted: true });
  }
  throw new InputError("Страница не найдена.", 404);
}
