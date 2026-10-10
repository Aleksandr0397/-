"use client";
import { useEffect, useRef, useState } from "react";
import { ShoppingCart, X, Minus, Plus, Trash2, ArrowRight, CheckCircle2 } from "lucide-react";
import { api, send, money, type CartLine, type Product, type Order, type User } from "./shared";
import { checkoutAttempt, pendingCheckout, completeCheckout, type CheckoutAttempt } from "../../lib/checkout-attempt";

export default function Cart({ open, onClose, cart, setCart, user, onOrdered, saleMode, setSaleMode }: { open: boolean; onClose: () => void; cart: CartLine[]; setCart: (cart: CartLine[]) => void; user: User | null; onOrdered: (order: Order) => void; saleMode: boolean; setSaleMode: (mode: boolean) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const attempt = useRef<CheckoutAttempt | null>(null);
  const [comment, setComment] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [balance, setBalance] = useState(0), [payFromBalance, setPayFromBalance] = useState(false);
  useEffect(() => { if (open && user) api<{ balanceCents: number }>("/api/wallet").then(x => setBalance(x.balanceCents)).catch(() => setBalance(0)); }, [open, user]);
  useEffect(() => {
    if (!open || !user) return;
    let pending: CheckoutAttempt | null = null;
    try { pending = pendingCheckout(user.id, localStorage); } catch { /* Storage can be disabled. */ }
    if (!pending || pending.payload.items.length !== cart.length || !pending.payload.items.every(item => cart.some(line => line.id === item.productId && line.quantity === item.quantity && line.priceCents === item.expectedPriceCents))) return;
    setComment(pending.payload.comment); setPayFromBalance(pending.payload.payFromBalance);
    if (user.role === "admin") setSaleMode(pending.payload.channel === "pos");
    attempt.current = pending;
  }, [open, user?.id]);
  useEffect(() => { if (open) { dialog.current?.showModal(); } else { dialog.current?.close(); } }, [open]);
  useEffect(() => { setError(""); }, [cart, comment, saleMode, payFromBalance]);
  const total = cart.reduce((sum, x) => sum + x.quantity * x.priceCents, 0);
  const change = (id: string, quantity: number) => setCart(cart.map(x => x.id === id ? { ...x, quantity: Math.max(1, Math.min(x.stock ?? 100000, Math.floor(quantity))) } : x));
  async function refreshPrices() {
    setBusy(true); setError("");
    try {
      const data = await api<{ items: Product[]; removed: string[] }>("/api/cart", send("POST", { items: cart.map(x => ({ productId: x.id, quantity: x.quantity })) }));
      setCart(cart.map(x => { const p = data.items.find(v => v.id === x.id); return p ? { ...p, quantity: x.quantity } : x; }));
      if (data.removed.length) setError("Некоторые товары отсутствуют в новом прайсе. Удалите их и выберите предложения заново.");
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function checkout() {
    if (busy) return;
    setBusy(true); setError("");
    try {
      const payload = { comment, channel: saleMode ? "pos" : "online", payFromBalance, items: cart.map(x => ({ productId: x.id, quantity: x.quantity, expectedPriceCents: x.priceCents })) };
      let storage: Storage | undefined;
      try { storage = localStorage; } catch { /* Browser privacy settings can disable local storage. */ }
      attempt.current = await checkoutAttempt(user!.id, payload, storage, attempt.current);
      const result = await api<{ order: Order }>("/api/orders", send("POST", { idempotencyKey: attempt.current.key, ...payload }));
      completeCheckout(attempt.current, storage); attempt.current = null;
      setCart([]); setComment(""); onClose(); onOrdered(result.order);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <dialog ref={dialog} className="cart-dialog" onCancel={onClose} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div className="drawer-header"><div><span className="eyebrow">Ваш заказ</span><h2>Корзина <span>{cart.length}</span></h2></div><button className="icon-button" onClick={onClose} aria-label="Закрыть корзину"><X /></button></div>
    <div className="drawer-body">
      {!cart.length ? <div className="empty"><ShoppingCart size={42} /><h3>Пока ничего нет</h3><p>Найдите нужные детали и добавьте их в корзину.</p><button className="button primary" onClick={onClose}>К поиску <ArrowRight size={17} /></button></div> :
        cart.map(x => <div className="cart-item" key={x.id}><div className="cart-item-head"><span className="article">{x.code}</span><button className="icon-button small" disabled={busy} onClick={() => setCart(cart.filter(v => v.id !== x.id))} aria-label={"Удалить " + x.name}><Trash2 size={17} /></button></div><h3>{x.name}</h3><p className="muted">{x.brand || "Бренд не указан"}</p><div className="cart-item-foot"><div className="stepper"><button disabled={busy || x.quantity <= 1} onClick={() => change(x.id, x.quantity - 1)} aria-label="Уменьшить количество"><Minus size={14} /></button><input aria-label={"Количество " + x.name} type="number" min="1" max={x.stock ?? 100000} value={x.quantity} disabled={busy} onChange={e => change(x.id, Number(e.target.value) || 1)} /><button disabled={busy || x.quantity >= (x.stock ?? 100000)} onClick={() => change(x.id, x.quantity + 1)} aria-label="Увеличить количество"><Plus size={14} /></button></div><strong>{money(x.priceCents * x.quantity)}</strong></div></div>)}
      {!!cart.length && <label className="field">Комментарий к заказу<textarea value={comment} onChange={e => setComment(e.target.value)} disabled={busy} maxLength={2000} placeholder="Например, удобное время получения" rows={3} /></label>}
      {error && <div role="alert" className="error">{error}</div>}
      {!!cart.length && <button className="button subtle wide" disabled={busy} onClick={refreshPrices}>Обновить цены и наличие</button>}
      {!!cart.length && user?.role === "admin" && <label className="pay-option"><input type="checkbox" checked={saleMode} disabled={busy} onChange={e => setSaleMode(e.target.checked)} /> Учётная продажа с прилавка</label>}
      {saleMode && <p className="muted">Продажа спишет остаток и сохранится в учёте. Касса ещё не подключена: фискальный чек нужно оформлять отдельно.</p>}
      {!!cart.length && user && <label className="pay-option"><input type="checkbox" checked={payFromBalance} disabled={busy || balance < total} onChange={e => setPayFromBalance(e.target.checked)} /> Оплатить с баланса · {money(balance)}</label>}
    </div>
    {!!cart.length && <div className="drawer-footer"><div className="total"><span>Итого</span><strong>{money(total)}</strong></div><p className="muted">Заказ поступит в кабинет администратора. Оплата и получение согласовываются отдельно.</p>{user ? <button className="button red wide" disabled={busy} onClick={checkout}>{busy ? "Сохраняем заказ…" : "Оформить заказ"}<ArrowRight size={18} /></button> : <a className="button red wide" target="_top" href="/signin-with-chatgpt?return_to=%2F">Войти и оформить заказ <ArrowRight size={18} /></a>}<div className="drawer-assurance"><CheckCircle2 size={15} /> Заказ сохранится в личном кабинете</div></div>}
  </dialog>;
}
