import { z } from "zod";
import { InputError } from "./inventory-domain";

export const maxPhotoBytes = 3_000_000;
export const maxProductPhotos = 5;
export const photoRecordSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9:_-]{1,80}$/), product_id: z.string().min(1).max(80),
  file_key: z.string().min(1).max(300), filename: z.string().min(1).max(180),
  content_type: z.enum(["image/jpeg", "image/png", "image/webp"]),
  size_bytes: z.number().int().min(1).max(maxPhotoBytes),
  width: z.number().int().min(1).max(6000), height: z.number().int().min(1).max(6000),
  position: z.number().int().min(0).max(maxProductPhotos - 1), created_at: z.string().datetime(),
});
export type PhotoRecord = z.infer<typeof photoRecordSchema>;
export type ProductPhoto = { id: string; url: string; filename: string; width: number; height: number; position: number };
export const photoUrl = (id: string) => "/api/product-photos/" + encodeURIComponent(id);
export const photoView = (row: PhotoRecord): ProductPhoto => ({ id: row.id, url: photoUrl(row.id), filename: row.filename, width: row.width, height: row.height, position: row.position });
const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

// Inspect raster containers; MIME types and filenames supplied by the uploader
// are not authoritative. Pixel decoding stays in the browser.
export function inspectPhoto(bytes: Uint8Array) {
  const invalid = () => { throw new InputError("Выберите фотографию JPEG, PNG или WebP. Файл повреждён или имеет другой формат."); };
  if (!bytes.length || bytes.length > maxPhotoBytes) throw new InputError("Размер фотографии должен быть от 1 байта до 3 МБ.", 413);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (offset: number, length: number) => String.fromCharCode(...bytes.subarray(offset, offset + length));
  let width = 0, height = 0, contentType = "";
  if (bytes.length >= 45 && ascii(1, 3) === "PNG" && bytes[0] === 137 && ascii(4, 4) === "\r\n\x1a\n") {
    if (view.getUint32(8) !== 13 || ascii(12, 4) !== "IHDR") return invalid();
    width = view.getUint32(16); height = view.getUint32(20); contentType = "image/png";
    let offset = 8, data = false, ended = false;
    while (offset + 12 <= bytes.length) {
      const length = view.getUint32(offset), kind = ascii(offset + 4, 4);
      if (offset + 12 + length > bytes.length) return invalid();
      let crc = 0xffffffff;
      for (let byte = offset + 4; byte < offset + 8 + length; byte++) crc = crcTable[(crc ^ bytes[byte]) & 255] ^ (crc >>> 8);
      if (((crc ^ 0xffffffff) >>> 0) !== view.getUint32(offset + 8 + length)) return invalid();
      if (kind === "acTL") throw new InputError("Загрузите неподвижную фотографию, без анимации.");
      if (kind === "IDAT" && length) data = true;
      offset += length + 12;
      if (kind === "IEND") { ended = length === 0 && offset === bytes.length; break; }
    }
    if (!data || !ended) return invalid();
  } else if (bytes.length >= 16 && bytes[0] === 255 && bytes[1] === 216 && bytes.at(-2) === 255 && bytes.at(-1) === 217) {
    contentType = "image/jpeg";
    let offset = 2, scan = false;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 255) return invalid();
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === 217) break;
      if (marker === 1 || marker >= 208 && marker <= 215) continue;
      if (offset + 2 > bytes.length) return invalid();
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) return invalid();
      if ([192,193,194].includes(marker)) {
        if (length < 8) return invalid();
        height = view.getUint16(offset + 3); width = view.getUint16(offset + 5);
      }
      if (marker === 218) { scan = true; break; }
      offset += length;
    }
    if (!scan) return invalid();
  } else if (bytes.length >= 30 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
    if (view.getUint32(4, true) + 8 !== bytes.length) return invalid();
    contentType = "image/webp";
    let offset = 12, image = false;
    while (offset + 8 <= bytes.length) {
      const kind = ascii(offset, 4), length = view.getUint32(offset + 4, true), start = offset + 8;
      if (start + length + (length % 2) > bytes.length) return invalid();
      if (kind === "ANIM" || kind === "ANMF") throw new InputError("Загрузите неподвижную фотографию, без анимации.");
      if (kind === "VP8X") {
        if (length !== 10 || bytes[start] & 2) return invalid();
        width = 1 + bytes[start+4] + (bytes[start+5] << 8) + (bytes[start+6] << 16);
        height = 1 + bytes[start+7] + (bytes[start+8] << 8) + (bytes[start+9] << 16);
      }
      if (kind === "VP8 ") {
        if (length < 10 || bytes[start] & 1 || ascii(start+3, 3) !== "\x9d\x01\x2a") return invalid();
        width ||= view.getUint16(start+6, true) & 16383; height ||= view.getUint16(start+8, true) & 16383; image = true;
      }
      if (kind === "VP8L") {
        if (length < 5 || bytes[start] !== 47) return invalid();
        const bits = view.getUint32(start+1, true);
        width ||= 1 + (bits & 16383); height ||= 1 + ((bits >>> 14) & 16383); image = true;
      }
      offset = start + length + (length % 2);
    }
    if (!image || offset !== bytes.length) return invalid();
  } else return invalid();
  if (!width || !height || width > 6000 || height > 6000 || width * height > 24_000_000) throw new InputError("Фотография должна быть не больше 6000 пикселей по стороне и 24 мегапикселей. Уменьшите изображение.");
  return { width, height, contentType: contentType as PhotoRecord["content_type"] };
}
