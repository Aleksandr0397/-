export class InputError extends Error { constructor(message: string, public status = 400) { super(message); } }
export type PriceRow = { code: string; brand: string; name: string; stock: number | null; priceCents: number };
export const normalize = (v: string) => v.normalize("NFKC").toLocaleLowerCase("ru-RU").replace(/\s+/g, " ").trim();
export function text(v: unknown, label: string, max = 200, required = true) {
  if (typeof v !== "string" || v.trim().length > max || (required && !v.trim())) throw new InputError("Проверьте поле «" + label + "».");
  return v.trim();
}
export function positiveInt(v: unknown, label: string, max = 1000000000) {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 1 || v > max) throw new InputError("Проверьте поле «" + label + "».");
  return v;
}
export function stockValue(v: unknown): number | null {
  if (v === null || v === "") return null;
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0 || v > 10000000) throw new InputError("Остаток должен быть целым числом не меньше нуля.");
  return v;
}
export function validateRows(value: unknown): PriceRow[] {
  if (!Array.isArray(value) || !value.length || value.length > 10000) throw new InputError("Прайс должен содержать от 1 до 10 000 строк.");
  const seen = new Set<string>();
  return value.map((r, i) => {
    if (!r || typeof r !== "object") throw new InputError("Некорректная строка прайса " + (i + 1) + ".");
    const row = { code: text(r.code, "Артикул", 80), brand: text(r.brand ?? "", "Бренд", 100, false),
      name: text(r.name, "Название", 400), stock: stockValue(r.stock ?? null), priceCents: positiveInt(r.priceCents, "Цена") };
    const key = normalize(row.code) + "\u0000" + normalize(row.brand);
    if (seen.has(key)) throw new InputError("Повтор артикула и бренда в строке " + (i + 1) + ".");
    seen.add(key); return row;
  });
}
export function mergeCart(value: unknown): { productId: string; quantity: number }[] {
  if (!Array.isArray(value) || !value.length || value.length > 80) throw new InputError("Корзина должна содержать от 1 до 80 позиций.");
  const items = new Map<string, number>();
  for (const row of value) {
    if (!row || typeof row !== "object") throw new InputError("Некорректная позиция корзины.");
    const id = text(row.productId, "Товар", 80);
    items.set(id, positiveInt((items.get(id) ?? 0) + positiveInt(row.quantity, "Количество", 100000), "Количество", 100000));
  }
  return [...items].map(([productId, quantity]) => ({ productId, quantity }));
}
export function customerPrice(base: number, discount: number, markup = 0) { return Math.max(1, Math.round(base * (10000 + markup) * (10000 - discount) / 100000000)); }
