"use client";
import { useEffect, useState } from "react";
import { Upload, FileSpreadsheet, Download, UsersRound, Database, Package, CheckCircle2, ArrowRight, Archive, Truck, Mail } from "lucide-react";
import { api, send, money, date, type SiteInfo, type Product } from "./shared";
import { readPrice, detectColumns, mapPrice, templateFile, download, type ColumnMap } from "../../lib/spreadsheets";
import Purchasing from "./purchasing";
import Movements from "./movements";
import AddProduct from "./add-product";
import Integrations from "./integrations";
import Suppliers from "./suppliers";
import ProductPhotos from "./product-photos";
import ShopSettings from "./shop-settings";
import type { Supplier } from "../../lib/suppliers";
import { createBackupManifest, parseBackupManifest, verifyBackupPart } from "../../lib/backup-integrity";

type Customer = { id: string; name: string; email: string; role: string; markup_bps: number; balance_cents: number };
const sectionTitles: Record<string, string> = { price: "Загрузка прайса", suppliers: "Поставщики", stock: "Товары и остатки", customers: "Персональные наценки", purchasing: "Закупки и проценка", movements: "Журнал движения", notifications: "Уведомления о заказах", integrations: "Подключения", backup: "Резервные копии" };
export default function Admin({ info, reload, notify, sell }: { info: SiteInfo; reload: () => void; notify: (s: string) => void; sell: (product: Product) => void }) {
  const [photoProduct, setPhotoProduct] = useState<Product | null>(null);
  const [section, setSection] = useState("price"), [file, setFile] = useState<File | null>(null), [raw, setRaw] = useState<string[][]>([]);
  const [map, setMap] = useState<ColumnMap>({ code: -1, brand: -1, name: -1, price: -1, stock: -1 }), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [sourceType, setSourceType] = useState("warehouse"), [sourceName, setSourceName] = useState("Мой склад"), [leadDays, setLeadDays] = useState("");
  const [stockMode, setStockMode] = useState("physical"), [stockPage, setStockPage] = useState(0), [stockTotal, setStockTotal] = useState(0), [stockRevision, setStockRevision] = useState(0);
  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  const [customers, setCustomers] = useState<Customer[]>([]), [stockQuery, setStockQuery] = useState(""), [stockRows, setStockRows] = useState<Product[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]), [supplierId, setSupplierId] = useState(""), [supplierRevision, setSupplierRevision] = useState(0);
  useEffect(() => {
    if (section !== "price") return;
    const controller = new AbortController();
    api<{ suppliers: Supplier[] }>("/api/suppliers", { signal: controller.signal }).then(result => { setSuppliers(result.suppliers); setSupplierId(current => result.suppliers.some(s => s.id === current && s.enabled && s.connection_type !== "api") ? current : ""); }).catch(e => { if (e.name !== "AbortError") setError(e.message); });
    return () => controller.abort();
  }, [section, supplierRevision]);
  useEffect(() => { if (section === "customers") api<{ customers: Customer[] }>("/api/customers").then(x => setCustomers(x.customers)).catch(e => setError(e.message)); }, [section]);
  useEffect(() => {
    if (section !== "stock") return;
    const controller = new AbortController();
    const timer = setTimeout(() => api<{ items: Product[]; total: number }>("/api/products?q=" + encodeURIComponent(stockQuery) + "&page=" + stockPage, { signal: controller.signal }).then(x => { setStockRows(x.items); setStockTotal(x.total); }).catch(e => { if (e.name !== "AbortError") setError(e.message); }), 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [section, stockQuery, stockPage, stockRevision, info.productCount]);
  async function choose(selected?: File) {
    if (!selected) return; setBusy(true); setError(""); setFile(null); setRaw([]);
    try { const data = await readPrice(selected); if (data.length < 2) throw new Error("В прайсе должны быть заголовки и хотя бы один товар."); setMap(detectColumns(data[0])); setRaw(data); setFile(selected); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function importPrice() {
    if (!file) return; setBusy(true); setError("");
    try {
      const rows = mapPrice(raw, map); const form = new FormData();
      form.set("file", file); form.set("rows", JSON.stringify(rows)); form.set("sourceType", sourceType); form.set("sourceName", sourceName); form.set("leadDays", leadDays); form.set("stockMode", stockMode);
      if (sourceType === "supplier") form.set("supplierId", supplierId);
      const result = await api<{ count: number }>("/api/imports", { method: "POST", body: form });
      notify("Прайс загружен: " + result.count + " товаров"); setFile(null); setRaw([]); setSupplierRevision(x => x + 1); reload();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function backup() {
    setBusy(true); setError("");
    try {
      const dump = await api<Record<string, unknown>>("/api/backup");
      const files = (dump.imports as { id: string; filename: string; file_key: string | null }[]).filter(file => file.file_key);
      const photos = dump.product_photos as { id: string; filename: string; size_bytes: number }[];
      const { zipSync, strToU8 } = await import("fflate");
      const parts: Record<string, Uint8Array> = { "backup.json": strToU8(JSON.stringify(dump, null, 2)) };
      let expanded = parts["backup.json"].length;
      for (const f of [...files.map(f => ({ ...f, path: "files/" + f.id, url: "/api/import-files/" + f.id })), ...photos.map(f => ({ ...f, path: "photos/" + f.id, url: "/api/product-photos/" + f.id }))]) {
        const response = await fetch(f.url, { cache: "no-store" });
        if (!response.ok) throw new Error("Не удалось выгрузить файл " + f.filename);
        const bytes = new Uint8Array(await response.arrayBuffer()); expanded += bytes.length;
        if (expanded > 80_000_000) throw new Error("Полная копия превышает 80 МБ в распакованном виде. Выгрузка этого объёма требует увеличения лимита архива.");
        parts[f.path] = bytes;
      }
      parts["manifest.json"] = strToU8(JSON.stringify(await createBackupManifest(parts), null, 2));
      if (expanded + parts["manifest.json"].length > 80_000_000) throw new Error("Распакованная копия превышает 80 МБ.");
      const archive = zipSync(parts);
      if (archive.length > 64_000_000) throw new Error("Полная копия превышает лимит архива 64 МБ. Выгрузка этого объёма требует увеличения лимита.");
      download(archive as unknown as BlobPart, "Atoll-backup-" + new Date().toISOString().slice(0, 10) + ".zip", "application/zip");
      notify("Резервная копия готова");
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function restore() {
    if (!restoreFile) return; setBusy(true); setError("");
    try {
      if (restoreFile.size > 64000000) throw new Error("Максимальный размер архива — 64 МБ.");
      const { unzipSync, strFromU8 } = await import("fflate");
      let size = 0;
      const parts = unzipSync(new Uint8Array(await restoreFile.arrayBuffer()), { filter: f => { size += f.originalSize; if (f.originalSize > 16000000 || size > 80000000) throw new Error("Архив превышает допустимый размер."); return f.name === "backup.json" || f.name === "manifest.json" || f.name.startsWith("files/") || f.name.startsWith("photos/"); } });
      if (!parts["backup.json"]) throw new Error("В архиве нет backup.json.");
      const form = new FormData(); form.set("data", strFromU8(parts["backup.json"]));
      if (parts["manifest.json"]) {
        const manifest = parseBackupManifest(strFromU8(parts["manifest.json"]));
        for (const entry of manifest.entries) { if (!parts[entry.path]) throw new Error("В архиве отсутствует " + entry.path); await verifyBackupPart(manifest, entry.path, parts[entry.path]); }
        form.set("manifest", strFromU8(parts["manifest.json"]));
      }
      for (const [name, bytes] of Object.entries(parts)) if (name.startsWith("files/")) form.set("file:" + name.slice(6), new Blob([bytes as unknown as BlobPart]), name.slice(6));
      for (const [name, bytes] of Object.entries(parts)) if (name.startsWith("photos/")) form.set("photo:" + name.slice(7), new Blob([bytes as unknown as BlobPart]), name.slice(7));
      const result = await api<{ products: number; orders: number }>("/api/restore", { method: "POST", body: form });
      notify("Восстановлено: " + result.products + " товаров, " + result.orders + " заказов"); setRestoreFile(null); reload();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function updateCustomer(customer: Customer) { try { await api("/api/customers/" + customer.id, send("PATCH", { markupBps: customer.markup_bps })); notify("Индивидуальная наценка сохранена"); } catch (e) { setError((e as Error).message); } }
  async function updateStock(p: Product) { try { await api("/api/products/" + p.id, send("PATCH", { stock: p.stock, warehouse: p.warehouse, bin: p.bin, minStock: p.minStock })); notify("Остаток и место хранения сохранены"); reload(); setStockRevision(x => x + 1); } catch (e) { setError((e as Error).message); } }
  return <section className="admin-layout"><aside className="admin-nav"><span className="eyebrow">Управление магазином</span>{[["price", "Прайсы", FileSpreadsheet], ["suppliers", "Поставщики", Truck], ["stock", "Товары и остатки", Package], ["purchasing", "Закупки и проценка", Package], ["movements", "Журнал движения", Archive], ["customers", "Клиенты и наценки", UsersRound], ["notifications", "Уведомления", Mail], ["integrations", "Подключения", ArrowRight], ["backup", "Резервные копии", Database]].map(([key, label, Icon]) => { const I = Icon as typeof Package; return <button key={key as string} className={section === key ? "active" : ""} onClick={() => { setSection(key as string); setError(""); }}><I size={18} />{label as string}</button>; })}<div className="admin-note"><CheckCircle2 size={18} /><span>Товары и заказы сохраняются на сервере.</span></div></aside><div className="panel admin-panel">
    <div className="section-head"><div><span className="eyebrow">Администратор</span><h2>{sectionTitles[section]}</h2></div></div>
    {error && <div className="error" role="alert">{error}</div>}
    {section === "price" && <>
      <div className="admin-stats"><div><span>Товаров в каталоге</span><strong>{info.productCount.toLocaleString("ru")}</strong></div><div><span>Последнее обновление</span><strong className="stat-small">{info.price ? date(info.price.created_at) : "Прайс ещё не загружен"}</strong></div></div>
      <p className="admin-description">Загрузите остатки своего склада и прайсы поставщиков. Предложения всех источников будут доступны в едином поиске. Новый прайс обновляет только выбранный источник.</p>
      <div className="form-grid"><label className="field">Тип источника<select value={sourceType} onChange={e => { setSourceType(e.target.value); setSourceName(e.target.value === "warehouse" ? "Мой склад" : ""); setSupplierId(""); setLeadDays(e.target.value === "warehouse" ? "0" : ""); }}><option value="warehouse">Мой склад</option><option value="supplier">Поставщик</option></select></label>{sourceType === "warehouse" ? <label className="field">Название склада<input value={sourceName} maxLength={120} onChange={e => setSourceName(e.target.value)} placeholder="Название склада" /></label> : <label className="field">Поставщик<select value={supplierId} onChange={e => { setSupplierId(e.target.value); const selected = suppliers.find(s => s.id === e.target.value); setSourceName(selected?.name ?? ""); setLeadDays(selected ? String(selected.lead_days) : ""); }}><option value="">Выберите поставщика</option>{suppliers.filter(s => s.enabled && s.connection_type !== "api").map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>}<label className="field">Срок этого прайса, дней<input type="number" min="0" max="365" value={leadDays} onChange={e => setLeadDays(e.target.value)} placeholder={sourceType === "warehouse" ? "0 — доступно со склада" : "Из карточки поставщика"} /></label></div>
      {sourceType === "supplier" && <p className="admin-description">Нет нужного поставщика? <button className="text-link" onClick={() => setSection("suppliers")}>Добавить в разделе «Поставщики»</button>. Для загрузки файла выберите способ работы «Прайс» или «Прайс и API».</p>}
      {sourceType === "warehouse" && <label className="field stock-mode">Что означает остаток в файле<select value={stockMode} onChange={e => setStockMode(e.target.value)}><option value="physical">Физический остаток — вычесть открытые заказы</option><option value="available">Доступное количество — резервы уже вычтены</option></select><small>При обновлении сохраняются товары, ячейки и ранее оформленные заказы.</small></label>}
      <label className={"upload-zone " + (busy ? "disabled" : "")}><span className="upload-icon"><Upload size={27} /></span><strong>{busy ? "Обрабатываем прайс…" : file ? file.name : "Выберите Excel-прайс или CSV"}</strong><span>Первая строка — заголовки · до 10 000 товаров · до 8 МБ</span><span className="button primary">Выбрать файл <ArrowRight size={16} /></span><input type="file" accept=".xlsx,.csv" disabled={busy} onChange={e => { void choose(e.target.files?.[0]); e.target.value = ""; }} /></label>
      <button className="text-link" onClick={() => templateFile().catch(e => setError(e.message))}><Download size={16} /> Скачать шаблон Excel</button>
      {raw.length > 0 && <div className="import-preview"><h3>Соответствие колонок</h3><p className="muted">Проверьте поля перед загрузкой. Цена указывается в рублях, без наценки. Пустой остаток означает, что количество неизвестно.</p><div className="column-map">{Object.entries({ code: "Артикул *", brand: "Бренд", name: "Название *", price: "Цена *", stock: "Остаток" }).map(([key, label]) => <label className="field" key={key}>{label}<select value={map[key as keyof ColumnMap]} onChange={e => setMap({ ...map, [key]: Number(e.target.value) })}><option value="-1">Не выбрано</option>{raw[0].map((x, i) => <option key={i} value={i}>{x || "Колонка " + (i + 1)}</option>)}</select></label>)}</div><h3>Предпросмотр · {raw.length - 1} товаров</h3><div className="table-wrap"><table><thead><tr>{raw[0].map((x, i) => <th key={i}>{x}</th>)}</tr></thead><tbody>{raw.slice(1, 5).map((row, i) => <tr key={i}>{row.map((x, j) => <td key={j}>{x}</td>)}</tr>)}</tbody></table></div><div className="import-actions"><p className="muted">Предыдущие заказы и исходные файлы сохранятся.</p><button className="button primary" disabled={busy || (sourceType === "supplier" ? !supplierId : !sourceName.trim())} onClick={importPrice}>{busy ? "Загружаем…" : "Загрузить " + (raw.length - 1) + " товаров"}<Upload size={16} /></button></div></div>}
      <div className="integration-note"><strong>Автоматическое обновление</strong><p>Сейчас товары поставщиков загружаются через прайсы. Обновление по API и автоматический заказ требуют подключения ваших поставщиков.</p></div>
    </>}
    {section === "suppliers" && <Suppliers notify={notify} changed={() => { setSupplierRevision(x => x + 1); setStockRevision(x => x + 1); reload(); }} importSupplier={supplier => { setSourceType("supplier"); setSourceName(supplier.name); setSupplierId(supplier.id); setLeadDays(String(supplier.lead_days)); setSection("price"); }} />}
    {section === "notifications" && <ShopSettings notify={notify} />}
    {section === "stock" && <><AddProduct notify={notify} onCreated={() => { reload(); setStockRevision(x => x + 1); }} /><p className="admin-description">Найдите товар и измените доступное количество. Пустое поле означает, что остаток неизвестен.</p><input className="admin-search" placeholder="Артикул или название" value={stockQuery} onChange={e => { setStockQuery(e.target.value); setStockPage(0); }} aria-label="Поиск товаров для изменения остатков" /><div className="table-wrap"><table><thead><tr><th>Артикул</th><th>Наименование / источник</th><th>Цена</th><th>Склад / ячейка</th><th>Остаток / минимум</th><th /></tr></thead><tbody>{stockRows.map(p => <tr key={p.id}><td><b>{p.code}</b><small>{p.brand}</small></td><td>{p.name}<small>{p.sourceName}</small><button className="text-link" onClick={() => setPhotoProduct(p)}>Фотографии{p.photoCount ? " · " + p.photoCount : " · добавить"}</button></td><td>{money(p.priceCents)}</td><td><input className="number-input location-input" aria-label={"Склад " + p.code} placeholder="Склад" value={p.warehouse ?? ""} onChange={e => setStockRows(stockRows.map(x => x.id === p.id ? { ...x, warehouse: e.target.value } : x))} /><input className="number-input location-input" aria-label={"Ячейка " + p.code} placeholder="Ячейка" value={p.bin ?? ""} onChange={e => setStockRows(stockRows.map(x => x.id === p.id ? { ...x, bin: e.target.value } : x))} /></td><td><input className="number-input" aria-label={"Остаток " + p.code} type="number" min="0" value={p.stock ?? ""} onChange={e => setStockRows(stockRows.map(x => x.id === p.id ? { ...x, stock: e.target.value === "" ? null : Number(e.target.value) } : x))} /><input className="number-input min-stock-input" aria-label={"Минимальный остаток " + p.code} type="number" min="0" placeholder="Минимум" value={p.minStock ?? 0} onChange={e => setStockRows(stockRows.map(x => x.id === p.id ? { ...x, minStock: Number(e.target.value) } : x))} /></td><td><button className="button subtle" onClick={() => updateStock(p)}>Сохранить</button><button className="text-link" disabled={p.stock === 0} onClick={() => sell(p)}>В продажу</button><a className="text-link" target="_blank" rel="noopener" href={"/labels?ids=" + encodeURIComponent(p.id)}>Ценник</a></td></tr>)}</tbody></table></div>{stockTotal > 60 && <div className="pagination"><span>Страница {stockPage + 1} · {stockTotal} товаров</span><div><button className="button subtle" disabled={!stockPage} onClick={() => setStockPage(x => x - 1)}>Назад</button><button className="button subtle" disabled={(stockPage + 1) * 60 >= stockTotal} onClick={() => setStockPage(x => x + 1)}>Далее</button></div></div>}{!stockRows.length && <p className="muted">Товаров пока нет. Загрузите прайс в разделе «Прайсы».</p>}</>}
    {section === "purchasing" && <Purchasing customerId={info.user!.id} notify={notify} changed={() => { setStockRevision(x => x + 1); reload(); }} />}
    {section === "movements" && <Movements />}
    {section === "integrations" && <Integrations />}
    {section === "customers" && <><p className="admin-description">Укажите индивидуальную наценку к цене загруженного прайса. Клиент будет видеть свою итоговую цену. Изменения применяются к новым заказам.</p><div className="table-wrap"><table><thead><tr><th>Клиент</th><th>Баланс</th><th>Наценка, %</th><th /></tr></thead><tbody>{customers.map(c => <tr key={c.id}><td><b>{c.name}</b><small>{c.email}</small></td><td>{money(c.balance_cents)}</td><td><input className="number-input" type="number" min="0" max="1000" step="0.1" aria-label={"Наценка " + c.name} value={c.markup_bps / 100} onChange={e => setCustomers(customers.map(x => x.id === c.id ? { ...x, markup_bps: Math.round(Number(e.target.value) * 100) } : x))} /></td><td><button className="button subtle" onClick={() => updateCustomer(c)}>Сохранить</button></td></tr>)}</tbody></table></div></>}
    {section === "backup" && <><div className="backup-card"><Archive size={38} /><h3>Данные магазина — у вас</h3><p>Скачайте товары, клиентов, заказы, закупки, приёмки, фотографии и исходные прайсы одним ZIP-архивом. Контрольные суммы позволяют проверить, что файлы не повреждены.</p><button className="button primary" disabled={busy} onClick={backup}><Download size={17} />{busy ? "Собираем архив…" : "Скачать резервную копию"}</button></div><p className="admin-description">Храните копию в безопасном месте: в ней есть данные клиентов. Восстановление доступно только для пустой базы. Текущие данные не перезаписываются.</p><div className="backup-card"><h3>Исходный код сайта</h3><p>Скачайте интерфейс, серверную логику, схемы базы и инструкции переноса. В архив входит средство восстановления данных в обычную SQLite-базу на другом сервере.</p><a className="button subtle" href="/api/source"><Download size={17} /> Скачать код ZIP</a></div><div className="restore-card"><h3>Восстановить резервную копию</h3><p className="muted">Для нового пустого проекта. Максимум 64 МБ.</p><label className="field">Архив резервной копии<input type="file" accept=".zip" disabled={busy} onChange={e => setRestoreFile(e.target.files?.[0] ?? null)} /></label><button className="button primary" disabled={busy || !restoreFile || info.productCount > 0} onClick={restore}>{busy ? "Восстанавливаем…" : "Восстановить данные"}</button></div></>}
  </div>{photoProduct && <ProductPhotos key={photoProduct.id} product={photoProduct} editable close={() => setPhotoProduct(null)} changed={() => { reload(); setStockRevision(x => x + 1); }} />}</section>;
}
