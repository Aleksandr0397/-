"use client";
import { useState } from "react";
import { Eye, EyeOff, ShieldCheck } from "lucide-react";
import { api, send, date } from "./shared";
import { rosskoDeliveryLabel, rosskoDeliveryMethod, type RosskoConnection, type RosskoOptions } from "../../lib/rossko";
export type RosskoForm = { key1: string; key2: string; deliveryId: string };
export const emptyRossko: RosskoForm = { key1: "", key2: "", deliveryId: "" };
export default function RosskoFields({ supplierId, stored, value, change, checking, setChecking }: { supplierId?: string; stored?: RosskoConnection; value: RosskoForm; change: (value: RosskoForm) => void; checking: boolean; setChecking: (busy: boolean) => void }) {
  const [visible, setVisible] = useState([false, false]), [error, setError] = useState(""), [checked, setChecked] = useState<string | null>(null);
  async function check() {
    setChecking(true); setError(""); setChecked(null);
    try {
      const result = await api<{ ok: boolean; options: RosskoOptions; deliveryReady: boolean; deliveryWarning: string | null; deliveryId: string; addressId: number | null; checkedAt: string }>("/api/suppliers/rossko/check", send("POST", { supplierId, rossko: { key1: value.key1, key2: value.key2 } }));
      setChecked(result.checkedAt); setError(result.deliveryWarning ?? "");
      change({ ...value, deliveryId: result.deliveryId });
    } catch (e) { setError((e as Error).message); } finally { setChecking(false); }
  }
  function setKey(field: "key1" | "key2", key: string) { change({ ...value, [field]: key }); setChecked(null); setError(""); }
  return <div className="rossko-fields">
    <div className="form-grid">{(["key1", "key2"] as const).map((field, i) => <label className="field" key={field}>Ключ {i + 1} (KEY{i + 1})<div className="secret-input"><input type={visible[i] ? "text" : "password"} autoComplete="off" spellCheck={false} maxLength={32} value={value[field]} onChange={e => setKey(field, e.target.value.trim())} placeholder={stored?.[i ? "key2Saved" : "key1Saved"] ? "Сохранён · новый ключ для замены" : "Вставьте ключ ROSSKO"} /><button type="button" className="icon-button" aria-label={(visible[i] ? "Скрыть" : "Показать") + " введённый ключ " + (i + 1)} onClick={() => setVisible(visible.map((v, n) => n === i ? !v : v))}>{visible[i] ? <EyeOff size={18} /> : <Eye size={18} />}</button></div><small>{stored?.[i ? "key2Saved" : "key1Saved"] ? "Пустое поле сохраняет текущий ключ." : "Ключи выдаёт ROSSKO в личном кабинете."}</small></label>)}</div>
    <div className="rossko-check"><button type="button" className="button subtle" onClick={check} disabled={checking}><ShieldCheck size={17} />{checking ? "Проверяем ROSSKO…" : "Проверить подключение"}</button>{checked ? <span className="success" role="status">Ключи приняты · {date(checked)}</span> : stored?.verifiedAt && !value.key1 && !value.key2 ? <span className="muted">Последняя проверка: {date(stored.verifiedAt)}</span> : <span className="muted">Новые ключи проверяются при сохранении.</span>}</div>
    {(error || (stored?.deliveryWarning && !checked)) && <p className="error" role="alert">{error || stored?.deliveryWarning}</p>}
    <div className="rossko-delivery-address"><b>Способ доставки</b><p>{rosskoDeliveryMethod}</p><small>{rosskoDeliveryLabel}</small><small>Цены, сроки и интервалы получаем из ROSSKO при запросе.</small></div>
    <p className="muted">Сохраните карточку, чтобы применить ключи. Подключение получает цены и остатки по запросу. Сохранённые ключи скрыты, их можно заменить по отдельности.</p>
  </div>;
}
