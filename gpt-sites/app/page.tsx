"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Search, ShoppingCart, UserRound, Package, ArrowRight, ShieldCheck, FileSpreadsheet, Clock3, Settings2, LogOut, Check, X, ChevronLeft, ChevronRight, Plus, SlidersHorizontal, CircleHelp, CarFront, WalletCards } from "lucide-react";
import Cart from "../components/inventory/cart";
import Orders from "../components/inventory/orders";
import Admin from "../components/inventory/admin";
import Vin from "../components/inventory/vin";
import Wallet from "../components/inventory/wallet";
import ProductPhotos from "../components/inventory/product-photos";
import InstallApp from "../components/inventory/install-app";
import { api, money, date, type Product, type CartLine, type SiteInfo, type Order } from "../components/inventory/shared";

export default function Home() {
  const [source, setSource] = useState("");
  const [photoProduct, setPhotoProduct] = useState<Product | null>(null);
  const [saleMode, setSaleMode] = useState(false);
  const [info, setInfo] = useState<SiteInfo | null>(null), [query, setQuery] = useState(""), [page, setPage] = useState(0);
  const [products, setProducts] = useState<Product[]>([]), [total, setTotal] = useState(0), [loading, setLoading] = useState(true), [error, setError] = useState("");
  const [cart, updateCart] = useState<CartLine[]>([]), [cartReady, setCartReady] = useState(false), [cartOpen, setCartOpen] = useState(false);
  const [tab, setTab] = useState("catalog"), [notification, setNotification] = useState(""), [cabinet, setCabinet] = useState(false), [refresh, setRefresh] = useState(0);
  const search = useRef<HTMLInputElement>(null);
  const me = info?.user ?? null;
  const notify = useCallback((message: string) => setNotification(message), []);
  const reload = useCallback(() => setRefresh(x => x + 1), []);
  useEffect(() => { api<SiteInfo>("/api/me").then(setInfo).catch(e => setError(e.message)); }, [refresh]);
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setLoading(true); setError("");
      api<{ items: Product[]; total: number }>("/api/products?q=" + encodeURIComponent(query) + "&page=" + page + "&source=" + source, { signal: controller.signal })
        .then(data => { setProducts(data.items); setTotal(data.total); })
        .catch(e => { if (e.name !== "AbortError") setError(e.message); })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, query ? 250 : 0);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, page, refresh, me?.discountBps, source]);
  useEffect(() => {
    try { const stored = JSON.parse(localStorage.getItem("atoll-cart-v1") ?? "[]"); if (Array.isArray(stored)) updateCart(stored.filter(x => typeof x?.id === "string" && typeof x?.name === "string" && Number.isSafeInteger(x.quantity) && x.quantity > 0 && Number.isSafeInteger(x.priceCents)).slice(0, 80)); } catch { /* Empty cart is the safe fallback. */ }
    setCartReady(true);
  }, []);
  useEffect(() => { if (cartReady) localStorage.setItem("atoll-cart-v1", JSON.stringify(cart)); }, [cart, cartReady]);
  useEffect(() => { if (notification) { const timer = setTimeout(() => setNotification(""), 6500); return () => clearTimeout(timer); } }, [notification]);
  function add(p: Product) {
    const old = cart.find(x => x.id === p.id);
    if (p.stock === 0 || (p.stock !== null && (old?.quantity ?? 0) >= p.stock)) { notify("Достигнут доступный остаток"); return; }
    if (!old && cart.length >= 80) { notify("В одном заказе может быть до 80 позиций"); return; }
    updateCart(old ? cart.map(x => x.id === p.id ? { ...p, quantity: x.quantity + 1 } : x) : [...cart, { ...p, quantity: 1 }]);
    notify("Добавлено в корзину: " + p.code);
  }
  function ordered(o: Order) { notify("Заказ № " + o.id.slice(0, 8).toUpperCase() + " сохранён"); setTab("orders"); reload(); }
  const cartCount = cart.reduce((n, x) => n + x.quantity, 0);
  const cartTotal = cart.reduce((n, x) => n + x.quantity * x.priceCents, 0);
  return <div className="site-shell">
    <div className="topbar"><div className="container topbar-inner"><span><span className="online-dot" /> Портал заказа автозапчастей</span><span>Для вашего автомобиля и бизнеса</span></div></div>
    <header className="header"><div className="container header-inner"><button className="brand" onClick={() => { setTab("catalog"); setQuery(""); setPage(0); }} aria-label="Инвентари Атолл — главная"><span className="brand-icon"><Package size={26} strokeWidth={1.8} /></span><span><b>АТОЛЛ<span className="brand-dot">.</span></b><small>ИНВЕНТАРИ · АВТОЗАПЧАСТИ</small></span></button><div className="header-caption">Нужная деталь.<br /><strong>В правильном месте.</strong></div><div className="header-actions"><div className="cabinet-wrap"><button className="header-action" onClick={() => setCabinet(!cabinet)} aria-expanded={cabinet}><UserRound size={23} /><span><small>Личный кабинет</small><b>{me ? me.role === "admin" ? "Администратор" : me.name.split(" ")[0] : "Вход / регистрация"}</b></span></button>{cabinet && <div className="cabinet-popover">{me ? <><strong>{me.name}</strong><p>{me.email}</p>{me.discountBps > 0 && <span className="discount-badge">Ваша скидка {me.discountBps / 100}%</span>}<button onClick={() => { setTab("orders"); setCabinet(false); }}>История заказов <ArrowRight size={16} /></button><a href="/signout-with-chatgpt?return_to=%2F" target="_top"><LogOut size={16} /> Выйти</a></> : <><strong>Добро пожаловать</strong><p>Оформляйте заказы и следите за их статусом.</p><a className="button primary" href="/signin-with-chatgpt?return_to=%2F" target="_top">Войти через ChatGPT</a></>}</div>}</div><button className="header-action cart-button" onClick={() => setCartOpen(true)}><span className="cart-icon"><ShoppingCart size={23} />{!!cartCount && <i>{cartCount}</i>}</span><span><small>Корзина</small><b>{cartCount ? money(cartTotal) : "Пока пуста"}</b></span></button></div></div></header>
    <section className="search-band"><div className="container"><div className="search-copy"><span className="eyebrow">Запчасти без лишних шагов</span><h1>Начните с артикула.<br />Найдите нужную деталь.</h1><p>Ищите по артикулу, бренду или названию.<br />Цены и наличие — сразу в результатах.</p></div><form className="search-form" onSubmit={e => { e.preventDefault(); setTab("catalog"); search.current?.focus(); }}><Search size={23} /><input ref={search} value={query} onChange={e => { setQuery(e.target.value); setPage(0); setTab("catalog"); }} placeholder="Введите артикул, бренд или название запчасти" aria-label="Поиск запчастей" />{query && <button type="button" className="search-clear" aria-label="Очистить поиск" onClick={() => { setQuery(""); setPage(0); }}><X size={18} /></button>}<button className="search-submit">Найти <ArrowRight size={17} /></button></form><div className="search-hints"><span><Check size={14} /> Поиск по вашему прайсу</span><span><Check size={14} /> Корзина и история заказов</span><span><Check size={14} /> Персональные цены</span></div></div><div className="search-decoration" aria-hidden="true"><span /><span /><span /></div></section>
    <main className="container main-content"><nav className="tabs" aria-label="Разделы сайта"><button onClick={() => setTab("catalog")} className={tab === "catalog" ? "active" : ""}><Search size={17} /> Поиск запчастей</button><button onClick={() => setTab("vin")} className={tab === "vin" ? "active" : ""}><CarFront size={17} /> Подбор по VIN</button><button onClick={() => setTab("wallet")} className={tab === "wallet" ? "active" : ""}><WalletCards size={17} /> Баланс</button><button onClick={() => setTab("orders")} className={tab === "orders" ? "active" : ""}><Package size={17} /> {me?.role === "admin" ? "Заказы клиентов" : "Мои заказы"}</button>{me?.role === "admin" && <button className={"admin-tab " + (tab === "admin" ? "active" : "")} onClick={() => setTab("admin")}><Settings2 size={16} /> Администрирование</button>}</nav>
      {tab === "catalog" && <>
        <div className="catalog-heading"><div><span className="eyebrow">{query ? "Результаты поиска" : "Предложения из прайса"}</span><h2>{query ? "По запросу «" + query + "»" : "Каталог запчастей"} <span>{total}</span></h2></div>{info?.price && <span className="price-updated"><Clock3 size={15} /> Обновлён {date(info.price.created_at)}</span>}</div>
        {me && me.discountBps > 0 && <div className="personal-price"><ShieldCheck size={18} /> В результатах указаны ваши персональные цены со скидкой {me.discountBps / 100}%.</div>}
        <div className="source-filters">{[["", "Все предложения"], ["warehouse", "Мой склад"], ["supplier", "Под заказ"]].map(([key, label]) => <button key={key} className={source === key ? "active" : ""} onClick={() => { setSource(key); setPage(0); }}>{label}</button>)}</div><section className="panel catalog-panel">
          {error ? <div className="empty"><CircleHelp size={42} /><h3>Не удалось загрузить каталог</h3><p role="alert">{error}</p><button className="button primary" onClick={reload}>Повторить</button></div> : loading ? <div className="catalog-skeleton" aria-label="Загрузка каталога">{[1, 2, 3, 4].map(i => <div key={i}><span /><span /><span /><span /></div>)}</div> : !products.length ? <div className="empty catalog-empty"><div className="empty-symbol"><Search size={32} /></div><span className="eyebrow">{query ? "Попробуйте другой запрос" : "Всё начинается с вашего прайса"}</span><h3>{query ? "Подходящие детали не найдены" : "Каталог готов к загрузке"}</h3><p>{query ? "Проверьте артикул или введите часть названия. Поиск работает только по загруженным предложениям." : "Загрузите прайс с артикулами, названиями и ценами — товары появятся здесь, и можно будет оформить первый заказ."}</p>{me?.role === "admin" ? <button className="button primary" onClick={() => setTab("admin")}><FileSpreadsheet size={18} /> {query ? "Открыть управление прайсом" : "Загрузить Excel-прайс"}</button> : !me ? <a className="button primary" target="_top" href="/signin-with-chatgpt?return_to=%2F">Войти в кабинет <ArrowRight size={17} /></a> : null}</div> :
            <div className="table-wrap"><table className="catalog-table"><thead><tr><th>Артикул / бренд</th><th>Наименование детали</th><th>Наличие / источник</th><th>Срок</th><th className="price-cell">Цена, ₽</th><th aria-label="Добавить в корзину" /></tr></thead><tbody>{products.map(p => <tr key={p.id}><td><strong className="article">{p.code}</strong><small>{p.brand || "—"}</small></td><td><div className="product-with-photo">{p.photoUrl ? <button className="product-photo-thumb" onClick={() => setPhotoProduct(p)} aria-label={"Открыть фотографии " + p.name}><img src={p.photoUrl} alt={p.name} loading="lazy" width="58" height="58" />{(p.photoCount ?? 0) > 1 && <span>{p.photoCount}</span>}</button> : <span className="product-photo-thumb photo-placeholder" aria-hidden="true"><Package size={22} /></span>}<span className="product-name">{p.name}</span></div></td><td><span className={p.stock === 0 ? "availability none" : "availability"}><i />{p.stock === null ? "Уточнить наличие" : p.stock ? p.stock + " шт." : "Нет в наличии"}</span><small>{p.sourceType === "warehouse" ? "Со склада" : "Под заказ"}</small></td><td><span className="lead-time">{p.leadDays !== null ? p.leadDays === 0 ? "Доступно со склада" : "~ " + p.leadDays + " дн." : "Уточнить срок"}</span></td><td className="price-cell"><strong>{money(p.priceCents)}</strong></td><td><button className={"add-button " + (cart.some(x => x.id === p.id) ? "added" : "")} disabled={p.stock === 0} onClick={() => add(p)} aria-label={"Добавить в корзину " + p.name}>{cart.some(x => x.id === p.id) ? <Check size={18} /> : <Plus size={18} />}<span>В корзину</span></button></td></tr>)}</tbody></table></div>}
          {total > 60 && <div className="pagination"><span>Показано {page * 60 + 1}–{Math.min((page + 1) * 60, total)} из {total}</span><div><button className="icon-button" disabled={!page} onClick={() => setPage(page - 1)} aria-label="Предыдущая страница"><ChevronLeft /></button><span>{page + 1}</span><button className="icon-button" disabled={(page + 1) * 60 >= total} onClick={() => setPage(page + 1)} aria-label="Следующая страница"><ChevronRight /></button></div></div>}
        </section>
        <div className="benefits"><article><span><Search size={22} /></span><div><h3>Быстрый поиск</h3><p>Артикул, бренд или название.<br />Результаты появляются при вводе.</p></div></article><article><span><FileSpreadsheet size={22} /></span><div><h3>Удобный заказ</h3><p>Соберите корзину и сохраните.<br />Скачайте заказ в формате Excel.</p></div></article><article><span><ShieldCheck size={22} /></span><div><h3>Ваш личный кабинет</h3><p>История, статусы и ваши цены.<br />Все заказы под рукой.</p></div></article></div>
        <div className="how-to"><div><span className="eyebrow">От поиска до заказа</span><h3>Три простых шага</h3></div><ol><li><b>01</b><span>Найдите деталь<small>Введите артикул или название</small></span></li><li><b>02</b><span>Соберите корзину<small>Выберите нужное количество</small></span></li><li><b>03</b><span>Оформите заказ<small>Следите за статусом в кабинете</small></span></li></ol></div>
      </>}
      {tab === "orders" && <Orders key={refresh} user={me} notify={notify} />}
      {tab === "vin" && <Vin user={me} notify={notify} />}
      {tab === "wallet" && <Wallet user={me} notify={notify} />}
      {tab === "admin" && me?.role === "admin" && <Admin info={info!} reload={reload} notify={notify} sell={p => { add(p); setSaleMode(true); setCartOpen(true); }} />}
    </main>
    <footer className="footer"><div className="container footer-inner"><div className="footer-brand">АТОЛЛ<span>.</span><small>ИНВЕНТАРИ · АВТОЗАПЧАСТИ</small></div><p>Поиск запчастей. Персональные цены. Удобные заказы.</p><InstallApp /><span>© {new Date().getFullYear()} Инвентари Атолл</span></div></footer>
    {notification && <div className="toast" role="status"><Check size={18} /><span>{notification}</span><button aria-label="Закрыть уведомление" onClick={() => setNotification("")}><X size={16} /></button></div>}
    {photoProduct && <ProductPhotos key={photoProduct.id} product={photoProduct} close={() => setPhotoProduct(null)} />}
    <Cart saleMode={saleMode} setSaleMode={setSaleMode} open={cartOpen} onClose={() => setCartOpen(false)} cart={cart} setCart={updateCart} user={me} onOrdered={ordered} />
  </div>;
}
