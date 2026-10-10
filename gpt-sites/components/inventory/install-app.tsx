"use client";
import { useEffect, useState } from "react";
import { MonitorSmartphone, X } from "lucide-react";
type InstallPrompt = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };
export default function InstallApp() {
  const [prompt, setPrompt] = useState<InstallPrompt | null>(null), [help, setHelp] = useState(false), [installed, setInstalled] = useState(false);
  useEffect(() => {
    if (window.matchMedia("(display-mode: standalone)").matches) setInstalled(true);
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => { /* The online site remains usable. */ });
    const available = (event: Event) => { event.preventDefault(); setPrompt(event as InstallPrompt); };
    const complete = () => { setInstalled(true); setPrompt(null); setHelp(false); };
    window.addEventListener("beforeinstallprompt", available); window.addEventListener("appinstalled", complete);
    return () => { window.removeEventListener("beforeinstallprompt", available); window.removeEventListener("appinstalled", complete); };
  }, []);
  async function install() {
    if (!prompt) { setHelp(!help); return; }
    await prompt.prompt(); const choice = await prompt.userChoice; setPrompt(null);
    if (choice.outcome !== "accepted") setHelp(true);
  }
  if (installed) return null;
  return <div className="install-app"><button className="button subtle" onClick={() => install().catch(() => setHelp(true))}><MonitorSmartphone size={16} /> Установить приложение</button>{help && <div className="install-help"><button className="icon-button small" aria-label="Закрыть инструкцию" onClick={() => setHelp(false)}><X size={16} /></button><strong>Атолл на телефоне и компьютере</strong><p>Откройте сайт в Chrome или Edge и выберите в меню «Установить приложение». На iPhone: Safari → «Поделиться» → «На экран Домой».</p><p>Приложению нужен интернет, чтобы показывать актуальные остатки и сохранять заказы.</p><a href="/" target="_blank" rel="noopener">Открыть сайт в отдельном окне</a></div>}</div>;
}
