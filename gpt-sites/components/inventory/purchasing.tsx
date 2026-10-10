"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Package, Download, Check, RefreshCw, Truck } from "lucide-react";
import { api, ApiError, send, money, date, type Product } from "./shared";
import { download } from "../../lib/spreadsheets";
import { pendingMutation, mutationAttempt, completeMutation, type MutationAttempt } from "../../lib/mutation-attempt";

type Offer = Product & { basePriceCents: number; availableForPurchase: number | null };
type Need = { product: Product; quantity: number; incomingQty: number; recommendedId: string | null; offers: Offer[] };
type PurchaseItem = { id: string; code: string; brand: string; name: string; warehouse: string; bin: string; quantity: number; received_qty: number; unit_cost_cents: number; lead_days: number | null };
type Purchase = { id: string; supplier_name: string; status: string; total_cents: number; created_at: string; ordered_at: string | null; items: PurchaseItem[] };
type ReceiptPayload = { items: { itemId: string; quantity: number }[] };
type PurchasePayload = { items: { warehouseProductId: string; supplierProductId: string; quantity: number }[] };
const purchaseStatuses: Record<string, string> = { draft: "Черновик", ordered: "Заказан", partial: "Принят частично", received: "Принят", cancelled: "Отменён" };
async function exportPurchase(order: Purchase) {
  const Excel = await import("exceljs"), book = new Excel.Workbook(), sheet = book.addWorksheet("Заказ поставщику");
  sheet.columns = [{ header: "Артикул", key: "code", width: 22 }, { header: "Бренд", key: "brand", width: 20 }, { header: "Наименование", key: "name", width: 45 }, { header: "Количество", key: "qty", width: 16 }, { header: "Закупочная цена, ₽", key: "price", width: 23 }, { header: "Сумма, ₽", key: "total", width: 18 }, { header: "Принято", key: "received", width: 14 }];
  for (const item of order.items) sheet.addRow({ ...item, qty: item.quantity, price: item.unit_cost_cents / 100, total: item.unit_cost_cents * item.quantity / 100, received: item.received_qty });
  sheet.getRow(1).font = { bold: true }; sheet.getColumn(1).numFmt = "@";
  download(await book.xlsx.writeBuffer() as unknown as BlobPart, "Закупка-" + order.id.slice(0, 8) + ".xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
}

export default function Purchasing({ customerId, notify, changed }: { customerId: string; notify: (s: string) => void; changed: () => void }) {
  const [needs, setNeeds] = useState<Need[]>([]), [orders, setOrders] = useState<Purchase[]>([]);
  const [error, setError] = useState(""), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false);
  const [tab, setTab] = useState("needs"), [selected, setSelected] = useState<Record<string, string>>({});
  const attempt = useRef<MutationAttempt<PurchasePayload> | null>(null);
  const load = useCallback(async () => {
    const [demand, documents] = await Promise.all([api<{ needs: Need[] }>("/api/purchasing"), api<{ orders: Purchase[] }>("/api/purchase-orders")]);
    setNeeds(demand.needs); setOrders(documents.orders);
    setSelected(demand.needs.reduce((all, need) => ({ ...all, [need.product.id]: need.recommendedId ?? "" }), {}));
  }, []);
  useEffect(() => { load().catch(e => setError(e.message)).finally(() => setLoading(false)); }, [load]);
  async function createOrders() {
    setBusy(true); setError("");
    try {
      const items = needs.filter(n => n.quantity > 0 && selected[n.product.id]).slice(0, 100).map(n => ({ warehouseProductId: n.product.id, supplierProductId: selected[n.product.id], quantity: n.quantity }));
      if (!items.length) throw new Error("Выберите предложения для закупки.");
      attempt.current = await mutationAttempt("purchases:" + customerId, { items }, window.localStorage, attempt.current);
      const result = await api<{ orders: Purchase[] }>("/api/purchase-orders", send("POST", { ...attempt.current.payload, idempotencyKey: attempt.current.key }));
      completeMutation(attempt.current, window.localStorage); attempt.current = null;
      notify("Создано закупок: " + result.orders.length); await load(); setTab("documents"); changed();
    } catch (e) {
      if (e instanceof ApiError && e.status < 500 && attempt.current) { completeMutation(attempt.current, window.localStorage); attempt.current = null; }
      setError((e as Error).message);
    } finally { setBusy(false); }
  }
  async function changeStatus(order: Purchase, status: string) {
    setBusy(true); setError("");
    try { await api("/api/purchase-orders/" + order.id, send("PATCH", { status })); await load(); notify(status === "ordered" ? "Закупка отмечена заказанной" : "Закупка отменена"); changed(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <div className="purchase-panel">
    <p className="admin-description">Подберите предложения из прайсов, сохраните заказ поставщику и примите поступившие товары. Суммы закупки хранятся отдельно от цен продажи. Для отправки поставщику скачайте Excel.</p>
    <div className="source-filters"><button className={tab === "needs" ? "active" : ""} onClick={() => setTab("needs")}>Потребность</button><button className={tab === "documents" ? "active" : ""} onClick={() => setTab("documents")}>Закупки · {orders.length}</button><button disabled={busy} onClick={() => load().catch(e => setError(e.message))} aria-label="Обновить закупки"><RefreshCw size={14} /></button></div>
    {error && <p className="error" role="alert">{error}</p>}
    {loading ? <p className="muted">Рассчитываем потребность…</p> : tab === "needs" ? <>
      {needs.some(n => n.quantity > 0) && <div className="purchase-toolbar"><strong>{needs.filter(n => n.quantity > 0).length} позиций к закупке</strong><button className="button primary" disabled={busy || !needs.some(n => n.quantity > 0 && selected[n.product.id])} onClick={createOrders}><Check size={16} /> Сформировать закупки</button></div>}
      {!needs.length ? <div className="empty"><Package size={35} /><h3>Потребности пока нет</h3><p>Укажите минимальные остатки у складских товаров. Здесь появятся позиции для пополнения.</p></div> : needs.map(n => <article className="purchase-need" key={n.product.id}><div className="purchase-row"><div><strong>{n.product.code} · {n.product.brand}</strong><p>{n.product.name}</p><p>{n.product.warehouse} · {n.product.bin || "Без ячейки"}</p><p>Доступно {n.product.stock} · Минимум {n.product.minStock} · В закупках {n.incomingQty} · Нужно ещё {n.quantity} шт.</p></div>{n.quantity === 0 && <span className="status status-ready">Уже запланировано</span>}</div>
        {n.quantity > 0 && (n.offers.length ? <label className="field purchase-select">Предложение поставщика<select value={selected[n.product.id] ?? ""} disabled={busy} onChange={e => setSelected({ ...selected, [n.product.id]: e.target.value })}><option value="">Выбрать предложение</option>{n.offers.map(p => <option key={p.id} value={p.id} disabled={p.availableForPurchase !== null && p.availableForPurchase < n.quantity}>{p.sourceName} · {money(p.basePriceCents)} · {p.availableForPurchase === null ? "наличие уточнить" : p.availableForPurchase + " шт."} · {p.leadDays === null ? "срок уточнить" : p.leadDays + " дн."}</option>)}</select></label> : <p className="muted">Нет предложений с совпадающими артикулом и брендом. Загрузите прайс поставщика.</p>)}
      </article>)}<p className="muted">По умолчанию выбирается минимальная закупочная цена с достаточным известным остатком. Поставки с неуказанным наличием выбирайте после уточнения у поставщика. За один раз сохраняется до 100 позиций.</p>
    </> : !orders.length ? <div className="empty"><Truck size={35} /><h3>Закупок пока нет</h3><p>Сформируйте документы по рассчитанной потребности.</p></div> : orders.map(order => <article className="purchase-document" key={order.id}><div className="purchase-document-head"><div><h3>{order.supplier_name}</h3><p>№ {order.id.slice(0, 8).toUpperCase()} · {date(order.created_at)}</p></div><span className={"status status-" + order.status}>{purchaseStatuses[order.status]}</span><strong>{money(order.total_cents)}</strong></div><div className="table-wrap"><table><thead><tr><th>Товар</th><th>Склад / ячейка</th><th>Цена закупки</th><th>Заказано</th><th>Принято</th></tr></thead><tbody>{order.items.map(i => <tr key={i.id}><td><b>{i.code} · {i.brand}</b><small>{i.name}</small></td><td>{i.warehouse || "—"}<small>{i.bin || "Без ячейки"}</small></td><td>{money(i.unit_cost_cents)}</td><td>{i.quantity}</td><td>{i.received_qty}</td></tr>)}</tbody></table></div><div className="purchase-document-actions"><button className="button subtle" onClick={() => exportPurchase(order).catch(e => setError(e.message))}><Download size={15} /> Excel поставщику</button>{order.status === "draft" && <button className="button primary" disabled={busy} onClick={() => changeStatus(order, "ordered")}>Отметить заказанным</button>}{["draft", "ordered"].includes(order.status) && <button className="button subtle" disabled={busy} onClick={() => changeStatus(order, "cancelled")}>Отменить закупку</button>}</div>{["ordered", "partial", "received"].includes(order.status) && <ReceiptForm order={order} customerId={customerId} onSaved={async () => { await load(); changed(); }} notify={notify} />}</article>)}
  </div>;
}

function ReceiptForm({ order, customerId, onSaved, notify }: { order: Purchase; customerId: string; onSaved: () => Promise<void>; notify: (s: string) => void }) {
  const scope = "receive:" + customerId + ":" + order.id;
  const [quantities, setQuantities] = useState<Record<string, string>>({}), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [pending, setPending] = useState<MutationAttempt<ReceiptPayload> | null>(null);
  useEffect(() => { setPending(pendingMutation(scope, window.localStorage)); }, [scope]);
  async function receive() {
    setBusy(true); setError(""); let attempt = pending;
    try {
      const items = order.items.filter(i => Number(quantities[i.id]) > 0).map(i => ({ itemId: i.id, quantity: Number(quantities[i.id]) }));
      if (!attempt && !items.length) throw new Error("Укажите поступившее количество хотя бы у одной детали.");
      if (!attempt) attempt = await mutationAttempt(scope, { items }, window.localStorage);
      setPending(attempt);
      const response = await api<{ repeated?: boolean }>("/api/purchase-orders/" + order.id + "/receive", send("POST", { ...attempt.payload, idempotencyKey: attempt.key }));
      completeMutation(attempt, window.localStorage); setPending(null); setQuantities({});
      notify(response.repeated ? "Эта приёмка уже сохранена" : "Товары приняты на склад"); await onSaved();
    } catch (e) {
      if (e instanceof ApiError && e.status < 500 && attempt) { completeMutation(attempt, window.localStorage); setPending(null); }
      setError((e as Error).message);
    } finally { setBusy(false); }
  }
  if (order.status === "received" && !pending) return null;
  return <div className="receipt-form"><h4>{pending ? "Проверка незавершённой приёмки" : "Приёмка на склад"}</h4><p className="muted">{pending ? "Повторите прежний запрос, чтобы проверить сохранение. Одни и те же товары будут приняты один раз." : "Введите фактически поступившее количество. Остаток увеличится после сохранения приёмки."}</p>{error && <p className="error" role="alert">{error}</p>}<div className="receipt-fields">{order.items.filter(i => i.received_qty < i.quantity).map(i => <label className="field" key={i.id}>{i.code} · осталось {i.quantity - i.received_qty} шт.<input type="number" min="0" max={i.quantity - i.received_qty} step="1" disabled={busy || !!pending} value={quantities[i.id] ?? ""} placeholder="0" onChange={e => setQuantities({ ...quantities, [i.id]: e.target.value })} /></label>)}</div><button className="button primary" disabled={busy} onClick={receive}><Package size={15} /> {busy ? "Сохраняем…" : pending ? "Повторить прежнюю приёмку" : "Сохранить приёмку"}</button></div>;
}
