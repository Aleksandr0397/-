"use client";
import { useEffect, useState } from "react";
import { Plus, Pencil, Power, Truck, FileSpreadsheet, Plug, Save, X } from "lucide-react";
import { api, send, date } from "./shared";
import { connectionTypes, supplierInput, type Supplier, type SupplierInput } from "../../lib/suppliers";
const empty: SupplierInput = { name: "", connectionType: "price", leadDays: 3, contactName: "", phone: "", email: "", website: "", apiUrl: "", apiDocsUrl: "", notes: "", enabled: true };

export default function Suppliers({ notify, changed, importSupplier }: { notify: (message: string) => void; changed: () => void; importSupplier: (supplier: Supplier) => void }) {
  const [suppliers, setSuppliers] = useState<Supplier[]>([]), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [query, setQuery] = useState(""), [showDisabled, setShowDisabled] = useState(false);
  const [editing, setEditing] = useState<Supplier | "new" | null>(null), [form, setForm] = useState<SupplierInput>(empty);
  async function load() { const result = await api<{ suppliers: Supplier[] }>("/api/suppliers"); setSuppliers(result.suppliers); }
  useEffect(() => { const controller = new AbortController(); api<{ suppliers: Supplier[] }>("/api/suppliers", { signal: controller.signal }).then(result => setSuppliers(result.suppliers)).catch(e => { if (e.name !== "AbortError") setError(e.message); }).finally(() => { if (!controller.signal.aborted) setLoading(false); }); return () => controller.abort(); }, []);
  function edit(supplier: Supplier | "new") { setEditing(supplier); setForm(supplier === "new" ? { ...empty } : supplierInput(supplier)); setError(""); }
  async function save(event: React.FormEvent) {
    event.preventDefault(); if (!editing || busy) return; setBusy(true); setError("");
    try {
      await api(editing === "new" ? "/api/suppliers" : "/api/suppliers/" + editing.id, send(editing === "new" ? "POST" : "PATCH", { ...form, ...(editing === "new" ? {} : { expectedRevision: editing.revision }) }));
      await load(); setEditing(null); changed(); notify("Поставщик сохранён");
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function toggle(supplier: Supplier) {
    setBusy(true); setError("");
    try { await api("/api/suppliers/" + supplier.id, send("PATCH", { enabled: !supplier.enabled, expectedRevision: supplier.revision })); await load(); changed(); notify(supplier.enabled ? "Поставщик отключён" : "Поставщик включён"); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  const visible = suppliers.filter(s => (showDisabled || s.enabled) && (s.name + " " + s.contact_name).toLocaleLowerCase("ru").includes(query.toLocaleLowerCase("ru")));
  return <div className="supplier-section">
    <p className="admin-description">Добавляйте поставщиков вручную. Для каждого выберите загрузку прайса, API или оба способа. Название, контакты и условия можно изменить позже.</p>
    <div className="supplier-toolbar"><span className="muted">Всего: {suppliers.length} · включены: {suppliers.filter(s => s.enabled).length}</span><button className="button primary" disabled={busy || editing !== null} onClick={() => edit("new")}><Plus size={17} /> Добавить поставщика</button></div>
    {error && <div className="error" role="alert">{error}</div>}
    {editing && <form className="supplier-editor" onSubmit={save}>
      <div className="section-head"><h3>{editing === "new" ? "Новый поставщик" : "Карточка поставщика"}</h3><button type="button" className="icon-button" aria-label="Закрыть карточку" disabled={busy} onClick={() => setEditing(null)}><X size={19} /></button></div>
      <fieldset disabled={busy}>
        <div className="form-grid"><label className="field">Название *<input required maxLength={120} autoFocus value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="Например, Автозапчасти Север" /></label><label className="field">Способ работы<select value={form.connectionType} onChange={e => setForm({ ...form, connectionType: e.target.value as SupplierInput["connectionType"] })}>{Object.entries(connectionTypes).map(([key, title]) => <option key={key} value={key}>{title}</option>)}</select></label><label className="field">Обычный срок поставки, дней<input type="number" required min={0} max={365} value={form.leadDays} onChange={e => setForm({ ...form, leadDays: Number(e.target.value) })} /></label></div>
        <div className="form-grid"><label className="field">Контактное лицо<input maxLength={120} value={form.contactName} onChange={e => setForm({ ...form, contactName: e.target.value })} /></label><label className="field">Телефон<input type="tel" maxLength={60} value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} /></label><label className="field">Email поставщика<input type="email" maxLength={254} value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} /></label></div>
        <label className="field">Сайт поставщика<input type="url" maxLength={2000} placeholder="https://" value={form.website} onChange={e => setForm({ ...form, website: e.target.value })} /></label>
        {form.connectionType !== "price" && <div className="supplier-api-fields"><h4><Plug size={17} /> Подключение по API</h4><div className="form-grid"><label className="field">Адрес API<input type="url" maxLength={2000} placeholder="https://…" value={form.apiUrl} onChange={e => setForm({ ...form, apiUrl: e.target.value })} /></label><label className="field">Документация API<input type="url" maxLength={2000} placeholder="Ссылка на инструкцию поставщика" value={form.apiDocsUrl} onChange={e => setForm({ ...form, apiDocsUrl: e.target.value })} /></label></div><p className="muted">Карточка сохраняет сведения для подключения. Обмен ещё не включён: каждому API нужна отдельная настройка. Ключи доступа добавляются при подключении, их не нужно вписывать в ссылки или заметки.</p></div>}
        <label className="field">Заметки и условия<textarea rows={3} maxLength={2000} value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} placeholder="График доставки, условия возврата, контакт менеджера" /></label>
        <label className="supplier-checkbox"><input type="checkbox" checked={form.enabled} onChange={e => setForm({ ...form, enabled: e.target.checked })} /> Поставщик включён</label><p className="muted">У отключённого поставщика предложения скрываются из поиска и новых закупок. История заказов и загруженные прайсы сохраняются.</p>
        <div className="supplier-form-actions"><button type="button" className="button subtle" onClick={() => setEditing(null)}>Отмена</button><button type="submit" className="button primary"><Save size={17} />{busy ? "Сохраняем…" : "Сохранить поставщика"}</button></div>
      </fieldset>
    </form>}
    <div className="supplier-filters"><input className="admin-search" aria-label="Поиск поставщика" placeholder="Найти поставщика" value={query} onChange={e => setQuery(e.target.value)} /><label className="supplier-checkbox"><input type="checkbox" checked={showDisabled} onChange={e => setShowDisabled(e.target.checked)} /> Показывать отключённых</label></div>
    {loading ? <p className="muted">Загружаем поставщиков…</p> : !visible.length ? <div className="empty"><Truck size={34} /><h3>{suppliers.length ? "Поставщики не найдены" : "Добавьте первого поставщика"}</h3><p>{suppliers.length ? "Измените поиск или покажите отключённых." : "Можно вести 10–15 поставщиков и добавлять новых по мере необходимости."}</p></div> : <div className="suppliers-list">{visible.map(s => <article className={"supplier-card " + (s.enabled ? "" : "supplier-disabled")} key={s.id}>
      <div className="supplier-card-head"><Truck size={23} /><h3>{s.name}</h3><span className={"status " + (s.enabled ? "status-ready" : "status-cancelled")}>{s.enabled ? "Включён" : "Отключён"}</span></div>
      <p className="supplier-mode">{s.connection_type === "price" ? <FileSpreadsheet size={16} /> : <Plug size={16} />}{connectionTypes[s.connection_type]} · {s.lead_days} дн.</p>
      {(s.contact_name || s.phone || s.email) && <p className="supplier-contact">{[s.contact_name, s.phone, s.email].filter(Boolean).join(" · ")}</p>}
      {s.connection_type !== "api" && <p className="muted">В прайсе: {(s.product_count ?? 0).toLocaleString("ru")} товаров · {s.last_import_at ? date(s.last_import_at) : "Прайс ещё не загружен"}</p>}
      {s.connection_type !== "price" && <p className="supplier-api-status">API: обмен ещё не подключён{s.api_docs_url && <> · <a href={s.api_docs_url} target="_blank" rel="noopener">Документация</a></>}</p>}
      {s.notes && <p className="supplier-notes">{s.notes}</p>}
      <div className="supplier-card-actions"><button className="button subtle" disabled={busy || editing !== null} onClick={() => edit(s)}><Pencil size={15} /> Изменить</button>{s.enabled === 1 && s.connection_type !== "api" && <button className="button subtle" disabled={busy} onClick={() => importSupplier(s)}><FileSpreadsheet size={15} /> Загрузить прайс</button>}<button className="text-link" disabled={busy || editing !== null} onClick={() => toggle(s)}><Power size={14} />{s.enabled ? "Отключить" : "Включить"}</button></div>
    </article>)}</div>}
  </div>;
}
