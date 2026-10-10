"use client";
import { useEffect, useState } from "react";
import { api, money, type Product } from "../../components/inventory/shared";
export default function Labels() {
  const [items, setItems] = useState<Product[]>([]), [error, setError] = useState("");
  useEffect(() => { api<{ items: Product[] }>("/api/labels" + window.location.search).then(x => setItems(x.items)).catch(e => setError(e.message)); }, []);
  return <main className="labels-container"><div className="labels-controls"><h1>Печать ценников</h1><p>Проверьте названия и цены перед печатью.</p><button className="button primary" disabled={!items.length} onClick={() => window.print()}>Напечатать</button><a className="button subtle" href="/">К магазину</a>{error && <p className="error">{error}</p>}</div><div className="labels-grid">{items.map(p => <article className="price-label" key={p.id}><h3>{p.name}</h3><p>{p.brand} · {p.code}</p><strong>{money(p.priceCents)}</strong><small>Инвентари Атолл</small></article>)}</div></main>;
}
