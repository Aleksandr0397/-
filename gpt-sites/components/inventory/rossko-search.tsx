"use client";
import { useEffect, useRef, useState } from "react";
import { Search, Plug } from "lucide-react";
import { api, send, money, date } from "./shared";
import { rosskoDeliveryLabel, rosskoDeliveryMethod, rosskoSearchMethod, rosskoWarehouseNotice, rosskoDeliveryWarning, rosskoDateTime, type RosskoOffer } from "../../lib/rossko";
import { createRosskoSearchController, type RosskoSearchResult, type RosskoSearchState } from "../../lib/rossko-search-controller";
export default function RosskoSearch({ query, refresh, request, onOffers, onChoose }: { query: string; refresh: number; request: { query: string; sequence: number } | null; onOffers: (result: { query: string; offers: RosskoOffer[] }) => void; onChoose: (code: string) => void }) {
  const [suppliers, setSuppliers] = useState<{ id: string; name: string; deliveryReady: boolean }[]>([]), [selected, setSelected] = useState("");
  const [state, setState] = useState<RosskoSearchState>({ phase: "idle", query: "", result: null, error: "" });
  const { result, error } = state, busy = state.phase === "waiting" || state.phase === "searching";
  const engine = useRef<ReturnType<typeof createRosskoSearchController> | null>(null), handled = useRef(0), lastRefresh = useRef(refresh);
  useEffect(() => { const c = new AbortController(); api<{ suppliers: { id: string; name: string; deliveryReady: boolean }[] }>("/api/rossko/suppliers", { signal: c.signal }).then(r => { setSuppliers(r.suppliers); setSelected(old => r.suppliers.some(s => s.id === old) ? old : r.suppliers[0]?.id ?? ""); }).catch(e => { if (e.name !== "AbortError") setSuppliers([]); }); return () => c.abort(); }, [refresh]);
  useEffect(() => {
    const search = createRosskoSearchController({ request: (input, signal) => api<RosskoSearchResult>("/api/rossko/search", { ...send("POST", input), signal }), changed: next => { setState(next); onOffers({ query: next.query, offers: next.result?.offers ?? [] }); } });
    engine.current = search;
    return () => { search.dispose(); engine.current = null; };
  }, [onOffers]);
  function search() { if (selected) engine.current?.queue({ supplierId: selected, query }, true, true); }
  const ready = !!suppliers.find(s => s.id === selected)?.deliveryReady;
  useEffect(() => {
    if (lastRefresh.current !== refresh) { engine.current?.reset(); lastRefresh.current = refresh; }
    const explicit = !!request && request.sequence !== handled.current && request.query.trim() === query.trim();
    if (explicit && selected && ready) handled.current = request!.sequence;
    engine.current?.queue({ supplierId: ready ? selected : "", query }, explicit, explicit);
  }, [query, selected, ready, refresh, request, onOffers]);
  if (!suppliers.length) return null;
  return <section className="rossko-results" aria-label="Поиск по API поставщика"><h3><Plug size={19} /> Предложения поставщика и аналоги</h3><p className="rossko-address"><b>Поиск на складе ROSSKO в Михайловке</b><br />{rosskoSearchMethod} · {rosskoDeliveryMethod} магазина: {rosskoDeliveryLabel}</p>{!ready && <p className="error" role="status">{rosskoDeliveryWarning}</p>}<p className="muted">Введите хотя бы 2 символа артикула. Поиск запускается автоматически после короткой паузы; аналоги появляются вместе с предложениями поставщика.</p><div className="rossko-search-controls">{suppliers.length > 1 && <select aria-label="Поставщик для поиска по API" value={selected} disabled={busy} onChange={e => { setSelected(e.target.value); }}>{suppliers.map(s => <option value={s.id} key={s.id}>{s.name}</option>)}</select>}<button type="button" className="button primary" disabled={!ready || busy || query.trim().length < 2} onClick={() => void search()}><Search size={17} />{state.phase === "waiting" ? "Готовим поиск…" : busy ? "Запрашиваем поставщика…" : "Обновить предложения"}</button>{result && <span className="muted">Запрос «{result.query}» · {date(result.checkedAt)}</span>}</div>{error && <p className="error" role="alert">{error}</p>}{result && <>{result.offers.length ? <div className="table-wrap"><table className="catalog-table"><thead><tr><th>Артикул / бренд</th><th>Наименование</th><th>Наличие</th><th>Поступление на склад ROSSKO</th><th className="price-cell">Цена</th></tr></thead><tbody>{result.offers.map(p => <tr key={p.offerId}><td><button type="button" className="article article-link" onClick={() => onChoose(p.code)} aria-label={"Найти все предложения по артикулу " + p.code}>{p.code}</button><small>{p.brand}{p.analogue ? " · аналог" : ""}</small></td><td><span className="product-name">{p.name}</span>{p.type !== 0 && <small>{["", "Распродажа", "Уценённый товар", "Авиадоставка"][p.type]}</small>}</td><td><span className={p.stock ? "availability" : "availability none"}>{p.stock} шт.</span>{p.multiplicity > 1 && <small>Кратность: {p.multiplicity}</small>}{p.description && <small>{p.description}</small>}</td><td><span className="lead-time">{p.leadDays === 0 ? "0 дн." : p.leadDays + " дн."}</span>{p.deliveryStart && <small>С {rosskoDateTime(p.deliveryStart)}</small>}{p.deliveryEnd && <small>До {rosskoDateTime(p.deliveryEnd)}</small>}</td><td className="price-cell"><strong>{money(p.priceCents)}</strong></td></tr>)}</tbody></table></div> : <p className="muted" role="status">Поставщик не вернул предложений по этому артикулу.</p>}<p className="muted">Для заказа этих предложений обратитесь к менеджеру. Наличие и цена уточняются при оформлении.</p></>}<p className="muted">{rosskoWarehouseNotice}</p></section>;
}
