"use client";
import { useEffect, useState } from "react";
import { Link2, ArrowRight } from "lucide-react";
import { api, send, money, date } from "./shared";
type Provider = "moysklad" | "saby";
type Status = { provider: Provider; title: string; configured: boolean; missing: string[] };
type Preview = { provider: Provider; checkedAt: string; rows: { externalId: string; code: string; name: string; priceCents: number | null; externalStock: number | null }[]; nextCursor: number | null };
export default function Integrations() {
  const [services, setServices] = useState<Status[]>([]), [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  useEffect(() => { api<{ integrations: Status[] }>("/api/integrations").then(data => setServices(data.integrations)).catch(error => setError(error.message)); }, []);
  async function check(provider: Provider, cursor = 0) {
    setBusy(true); setError("");
    try { setPreview(await api<Preview>("/api/integrations/" + provider + "/check", send("POST", { cursor }))); }
    catch (error) { setError((error as Error).message); } finally { setBusy(false); }
  }
  return <div className="integration-section">
    <p className="admin-description">Подготовлены подключения к каталогам МойСклада и Saby. Сначала проверьте доступ, артикулы и цены. Для постоянного обмена остатками и заказами потребуется настроить правила синхронизации.</p>
    {error && <div className="error" role="alert">{error}</div>}
    <div className="integration-cards">{services.map(service => <article className="backup-card" key={service.provider}><Link2 size={28} /><h3>{service.title}</h3><p>{service.configured ? "Настройки заданы. Проверьте получение каталога." : "Требуется настройка доступа к вашему аккаунту."}</p><button className="button subtle" disabled={busy || !service.configured} onClick={() => check(service.provider)}>Проверить каталог <ArrowRight size={16} /></button><details><summary>Как подключить</summary><p>В настройках проекта GPT Sites добавьте токен как секрет, идентификатор колонки цен и единицу цены. Ключи сохраняются на сервере.</p><code>{(service.provider === "moysklad" ? ["MOYSKLAD_TOKEN", "MOYSKLAD_PRICE_TYPE_ID", "MOYSKLAD_PRICE_UNIT"] : ["SABY_ACCESS_TOKEN", "SABY_POINT_ID", "SABY_PRICE_LIST_ID", "SABY_PRICE_UNIT"]).join(", ")}</code><p>Единица цены: kopecks — копейки, rubles — рубли. Колонка должна содержать цены в рублях. После настройки примените переменные новой публикацией проекта.</p><a className="text-link" target="_blank" rel="noopener" href={service.provider === "moysklad" ? "https://dev.moysklad.ru/doc/api/remap/1.2/" : "https://saby.ru/help/integration/api/app_sale/sale_delyvery/catalog"}>Инструкция сервиса <ArrowRight size={14} /></a></details></article>)}</div>
    {preview && <><h3>Проверка {preview.provider === "moysklad" ? "МойСклада" : "Saby"} · {date(preview.checkedAt)}</h3><p className="muted">Предпросмотр ответа сервиса. Остатки и товары сайта сохраняются без изменений; автоматический обмен ещё не включён.</p><div className="table-wrap"><table><thead><tr><th>Артикул</th><th>Название</th><th>Цена</th><th>Остаток в сервисе</th></tr></thead><tbody>{preview.rows.map((row, i) => <tr key={row.externalId || i}><td>{row.code || "—"}</td><td>{row.name}</td><td>{row.priceCents === null ? "Цена не передана" : money(row.priceCents)}</td><td>{row.externalStock ?? "Не передан"}</td></tr>)}</tbody></table></div>{!preview.rows.length && <p className="muted">На странице нет товарных позиций. Проверьте публикацию прайса в сервисе.</p>}{preview.nextCursor !== null && <button className="button subtle" disabled={busy} onClick={() => check(preview.provider, preview.nextCursor!)}>Следующая страница</button>}</>}
  </div>;
}
