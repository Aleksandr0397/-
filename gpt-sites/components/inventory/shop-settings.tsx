"use client";
import { useEffect, useState } from "react";
import { Mail, Save } from "lucide-react";
import { api, send } from "./shared";
type Settings = { orderEmail: string; emailSendingConnected: boolean };
export default function ShopSettings({ notify }: { notify: (message: string) => void }) {
  const [email, setEmail] = useState(""), [settings, setSettings] = useState<Settings | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState("");
  useEffect(() => { const controller = new AbortController(); api<Settings>("/api/shop-settings", { signal: controller.signal }).then(result => { setSettings(result); setEmail(result.orderEmail); }).catch(e => { if (e.name !== "AbortError") setError(e.message); }); return () => controller.abort(); }, []);
  async function save(event: React.FormEvent) { event.preventDefault(); setBusy(true); setError(""); try { const result = await api<Settings>("/api/shop-settings", send("PATCH", { orderEmail: email })); setSettings(result); setEmail(result.orderEmail); notify("Адрес для заказов сохранён"); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }
  return <><p className="admin-description">Укажите адрес, на который нужно получать уведомления о заказах.</p>{error && <div className="error" role="alert">{error}</div>}<form className="backup-card shop-settings" onSubmit={save}><Mail size={32} /><h3>Получатель заказов</h3><label className="field">Email<input type="email" maxLength={254} value={email} disabled={!settings || busy} onChange={e => setEmail(e.target.value)} placeholder="name@example.ru" /></label><button className="button primary" disabled={!settings || busy} type="submit"><Save size={16} />{busy ? "Сохраняем…" : "Сохранить адрес"}</button>{settings && <p className="muted">{settings.emailSendingConnected ? "Отправка уведомлений подключена." : "Автоматическая отправка писем ещё не подключена. Сохранённый адрес будет использоваться после настройки почтового сервиса."}</p>}</form></>;
}
