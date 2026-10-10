import type { PriceRow } from "./inventory-domain";
export type ColumnMap = { code: number; brand: number; name: number; price: number; stock: number };
export async function readPrice(file: File): Promise<string[][]> {
  if (file.size > 8_000_000) throw new Error("Максимальный размер прайса — 8 МБ.");
  if (/\.xlsx$/i.test(file.name)) {
    const Excel = await import("exceljs");
    const workbook = new Excel.Workbook();
    await workbook.xlsx.load(await file.arrayBuffer());
    const sheet = workbook.worksheets[0];
    if (!sheet) throw new Error("В файле нет листов.");
    if (sheet.rowCount > 10001) throw new Error("Максимум 10 000 товаров в одном прайсе.");
    const rows: string[][] = [];
    sheet.eachRow(row => {
      const cells: string[] = [];
      for (let c = 1; c <= Math.min(sheet.columnCount, 60); c++) cells.push(row.getCell(c).text.trim());
      if (cells.some(Boolean)) rows.push(cells);
    });
    return rows;
  }
  if (/\.csv$/i.test(file.name)) return parseCsv(await file.text());
  throw new Error("Выберите Excel .xlsx или CSV. Файл .xls сначала сохраните в формате .xlsx.");
}
function parseCsv(input: string): string[][] {
  const first = input.replace(/^\uFEFF/, "").split(/\r?\n/)[0];
  const separator = first.split(";").length >= first.split(",").length ? ";" : ",";
  const rows: string[][] = [], row: string[] = [];
  let field = "", quoted = false;
  const source = input.replace(/^\uFEFF/, "");
  for (let i = 0; i <= source.length; i++) {
    const char = source[i];
    if (char === '"') {
      if (quoted && source[i + 1] === '"') { field += '"'; i++; } else quoted = !quoted;
    } else if (!quoted && (char === separator || char === "\n" || char === undefined)) {
      row.push(field.trim()); field = "";
      if (char !== separator) { if (row.some(Boolean)) rows.push([...row]); row.length = 0; }
    } else if (char !== "\r" || quoted) field += char;
  }
  if (quoted) throw new Error("В CSV не закрыты кавычки.");
  if (rows.length > 10001) throw new Error("Максимум 10 000 товаров в одном прайсе.");
  return rows;
}
export function detectColumns(headers: string[]): ColumnMap {
  const find = (pattern: RegExp) => headers.findIndex(x => pattern.test(x.toLowerCase()));
  return { code: find(/артикул|код|article|sku|part.?number/), brand: find(/бренд|производ|brand/), name: find(/наимен|назван|description|name/), price: find(/цена|price|стоимость/), stock: find(/остат|налич|колич|stock|qty/) };
}
export function mapPrice(raw: string[][], map: ColumnMap): PriceRow[] {
  if (map.code < 0 || map.name < 0 || map.price < 0) throw new Error("Укажите колонки артикула, названия и цены.");
  const used = Object.values(map).filter(x => x >= 0);
  if (new Set(used).size !== used.length) throw new Error("Для каждого поля выберите отдельную колонку.");
  const seen = new Set<string>();
  return raw.slice(1).map((r, i) => {
    const money = Number((r[map.price] ?? "").replace(/\s|₽|руб\.?/gi, "").replace(",", "."));
    const quantity = map.stock < 0 ? "" : r[map.stock] ?? "";
    const row = { code: r[map.code] ?? "", brand: map.brand < 0 ? "" : r[map.brand] ?? "", name: r[map.name] ?? "", priceCents: Math.round(money * 100), stock: quantity === "" ? null : Number(quantity.replace(",", ".")) };
    if (!row.code || !row.name || !Number.isFinite(money) || money <= 0 || !Number.isSafeInteger(row.priceCents) || row.priceCents > 1000000000) throw new Error("Проверьте артикул, название и цену в строке " + (i + 2) + ".");
    if (row.stock !== null && (!Number.isSafeInteger(row.stock) || row.stock < 0)) throw new Error("Некорректный остаток в строке " + (i + 2) + ".");
    const key = row.code.toLowerCase() + "\u0000" + row.brand.toLowerCase();
    if (seen.has(key)) throw new Error("Повтор артикула и бренда в строке " + (i + 2) + ".");
    seen.add(key);
    return row;
  });
}
export function download(data: BlobPart, filename: string, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement("a"); a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}
export async function templateFile() {
  const Excel = await import("exceljs"); const workbook = new Excel.Workbook();
  const sheet = workbook.addWorksheet("Прайс");
  sheet.columns = [{ header: "Артикул", key: "code", width: 22 }, { header: "Бренд", key: "brand", width: 20 }, { header: "Название", key: "name", width: 50 }, { header: "Цена", key: "price", width: 18 }, { header: "Остаток", key: "stock", width: 15 }];
  sheet.getRow(1).font = { bold: true };
  sheet.getColumn(1).numFmt = "@";
  download(await workbook.xlsx.writeBuffer() as unknown as BlobPart, "Шаблон-прайса.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
}
export async function exportOrder(order: { id: string; created_at: string; total_cents: number; comment: string; customer_email?: string; items: { code: string; brand: string; name: string; quantity: number; unit_price_cents: number }[] }) {
  const Excel = await import("exceljs"); const workbook = new Excel.Workbook();
  const sheet = workbook.addWorksheet("Заказ");
  sheet.columns = [{ header: "Артикул", key: "code", width: 22 }, { header: "Бренд", key: "brand", width: 20 }, { header: "Название", key: "name", width: 50 }, { header: "Количество", key: "qty", width: 15 }, { header: "Цена, ₽", key: "price", width: 18 }, { header: "Сумма, ₽", key: "total", width: 18 }];
  order.items.forEach(x => sheet.addRow({ code: x.code, brand: x.brand, name: x.name, qty: x.quantity, price: x.unit_price_cents / 100, total: x.unit_price_cents * x.quantity / 100 }));
  sheet.addRow({ name: "Итого", total: order.total_cents / 100 });
  sheet.addRow({ name: "Заказ " + order.id });
  sheet.addRow({ name: order.created_at });
  if (order.customer_email) sheet.addRow({ name: order.customer_email });
  if (order.comment) sheet.addRow({ name: "Комментарий: " + order.comment });
  sheet.getRow(1).font = { bold: true };
  sheet.getColumn(1).numFmt = "@";
  sheet.getColumn(5).numFmt = "0.00"; sheet.getColumn(6).numFmt = "0.00";
  download(await workbook.xlsx.writeBuffer() as unknown as BlobPart, "Заказ-" + order.id.slice(0, 8) + ".xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
}
