"use client";
import { useState, type FormEvent } from "react";
import { Plus } from "lucide-react";
import { api, send } from "./shared";

export default function AddProduct({ onCreated, notify }: { onCreated: () => void; notify: (message: string) => void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget; const values = new FormData(form);
    setBusy(true); setError("");
    try {
      await api("/api/products", send("POST", { code: values.get("code"), brand: values.get("brand"), name: values.get("name"),
        priceCents: Math.round(Number(String(values.get("price")).replace(",", ".")) * 100), stock: Number(values.get("stock")),
        sourceName: values.get("warehouse"), warehouse: values.get("warehouse"), bin: values.get("bin"), minStock: Number(values.get("minimum")) }));
      form.reset(); onCreated(); notify("Товар добавлен на склад");
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <details className="product-create"><summary><Plus size={17} /> Добавить товар вручную</summary><form onSubmit={submit}>
    <div className="form-grid"><label className="field">Артикул<input name="code" required maxLength={80} /></label><label className="field">Бренд<input name="brand" maxLength={100} /></label><label className="field">Наименование<input name="name" required maxLength={400} /></label></div>
    <div className="form-grid"><label className="field">Цена прайса, ₽<input name="price" type="number" required min="0.01" max="10000000" step="0.01" /></label><label className="field">Доступное количество<input name="stock" type="number" required min="0" max="10000000" step="1" defaultValue="0" /></label><label className="field">Минимальный остаток<input name="minimum" type="number" required min="0" max="10000000" step="1" defaultValue="0" /></label></div>
    <div className="form-grid"><label className="field">Название склада<input name="warehouse" required maxLength={120} defaultValue="Мой склад" /></label><label className="field">Ячейка<input name="bin" maxLength={80} placeholder="Например, А-03" /></label></div>
    {error && <p className="error" role="alert">{error}</p>}<button className="button primary" disabled={busy}>{busy ? "Сохраняем…" : "Добавить товар"}</button>
  </form></details>;
}
