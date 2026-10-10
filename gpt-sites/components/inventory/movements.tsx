"use client";
import { useEffect, useState } from "react";
import { api, date } from "./shared";
type Movement = { id: string; code: string; name: string; warehouse: string; bin: string; delta: number | null; kind: string; created_at: string; reference_id: string };
export default function Movements() {
  const [items, setItems] = useState<Movement[]>([]), [error, setError] = useState("");
  useEffect(() => { api<{ movements: Movement[] }>("/api/movements").then(x => setItems(x.movements)).catch(e => setError(e.message)); }, []);
  return <div className="movements-panel"><p className="admin-description">Заказы и изменения остатков. Пустое изменение означает, что количество товара не было известно.</p>{error && <p className="error">{error}</p>}<div className="table-wrap"><table><thead><tr><th>Дата</th><th>Товар</th><th>Склад / ячейка</th><th>Операция</th><th>Изменение</th></tr></thead><tbody>{items.map(m => <tr key={m.id}><td>{date(m.created_at)}</td><td><b>{m.code}</b><small>{m.name}</small></td><td>{m.warehouse || "—"}<small>{m.bin}</small></td><td>{m.kind === "order" ? "Заказ / продажа" : m.kind === "return" ? "Возврат резерва" : m.kind === "purchase_receipt" ? "Приёмка закупки" : "Корректировка"}</td><td>{m.delta === null ? "—" : m.delta > 0 ? "+" + m.delta : m.delta}</td></tr>)}</tbody></table></div>{!items.length && <p className="muted">Движений пока нет.</p>}</div>;
}
