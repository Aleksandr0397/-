"use client";
import { useEffect, useRef, useState } from "react";
import { Camera, ChevronLeft, ChevronRight, Trash2, Upload, X } from "lucide-react";
import { api, type Product } from "./shared";
import { inspectPhoto, maxPhotoBytes, maxProductPhotos, type ProductPhoto } from "../../lib/product-photos";

export default function ProductPhotos({ product, editable = false, close, changed }: { product: Product; editable?: boolean; close: () => void; changed?: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [photos, setPhotos] = useState<ProductPhoto[]>([]), [index, setIndex] = useState(0);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const selected = photos[Math.min(index, Math.max(0, photos.length - 1))];
  const path = "/api/products/" + encodeURIComponent(product.id) + "/photos";
  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => {
    const controller = new AbortController();
    api<{ photos: ProductPhoto[] }>(path, { signal: controller.signal }).then(result => setPhotos(result.photos)).catch(e => { if (e.name !== "AbortError") setError(e.message); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [path]);
  async function refresh() { const result = await api<{ photos: ProductPhoto[] }>(path); setPhotos(result.photos); changed?.(); return result.photos; }
  async function upload(file?: File) {
    if (!file) return;
    setBusy(true); setError("");
    try {
      if (!file.size || file.size > maxPhotoBytes) throw new Error("Выберите фотографию размером до 3 МБ.");
      inspectPhoto(new Uint8Array(await file.arrayBuffer()));
      const previewUrl = URL.createObjectURL(file);
      try {
        await new Promise<void>((resolve, reject) => { const image = new Image(); image.onload = () => resolve(); image.onerror = () => reject(new Error("Не удалось открыть изображение. Выберите другую фотографию.")); image.src = previewUrl; });
      } finally { URL.revokeObjectURL(previewUrl); }
      const form = new FormData(); form.set("file", file);
      const result = await api<{ photo: ProductPhoto }>(path, { method: "POST", body: form });
      const next = await refresh(); setIndex(Math.max(0, next.findIndex(x => x.id === result.photo.id)));
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function remove() {
    if (!selected) return;
    setBusy(true); setError("");
    try { await api(path + "/" + encodeURIComponent(selected.id), { method: "DELETE" }); await refresh(); setIndex(0); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return <dialog ref={dialog} className="photo-dialog" aria-labelledby="photo-title" onCancel={close} onClose={close} onClick={event => { if (event.target === event.currentTarget) close(); }}>
    <div className="photo-header"><div><span className="eyebrow">{product.code} · {product.brand || "Без бренда"}</span><h2 id="photo-title">{product.name}</h2><p>{product.sourceName}</p></div><button className="icon-button" onClick={close} aria-label="Закрыть фотографии"><X size={22} /></button></div>
    <div className="photo-body">
      {error && <p className="error" role="alert">{error}</p>}
      {loading ? <p className="loading-line">Загружаем фотографии…</p> : selected ? <>
        <div className="photo-stage"><img src={selected.url} alt={product.name + " — фото " + (index + 1)} width={selected.width} height={selected.height} />{photos.length > 1 && <><button className="photo-prev icon-button" onClick={() => setIndex((index + photos.length - 1) % photos.length)} aria-label="Предыдущее фото"><ChevronLeft /></button><button className="photo-next icon-button" onClick={() => setIndex((index + 1) % photos.length)} aria-label="Следующее фото"><ChevronRight /></button></>}</div>
        <div className="photo-thumbnails" aria-label="Фотографии товара">{photos.map((photo, n) => <button key={photo.id} className={photo.id === selected.id ? "selected" : ""} onClick={() => setIndex(n)} aria-label={"Открыть фото " + (n+1)} aria-pressed={photo.id === selected.id}><img src={photo.url} alt={"Фото " + (n+1)} loading="lazy" /></button>)}</div>
        <p className="photo-caption">Фото {Math.min(index+1, photos.length)} из {photos.length}{editable && " · Первое фото отображается в каталоге"}</p>
      </> : <div className="photo-empty"><Camera size={38} /><p>Фотографий пока нет.</p>{editable && <small>Загрузите фотографию этой детали.</small>}</div>}
      {editable && !loading && <div className="photo-tools"><label className="field photo-upload">Добавить фото<input type="file" accept="image/jpeg,image/png,image/webp" disabled={busy || photos.length >= maxProductPhotos} onChange={e => { void upload(e.target.files?.[0]); e.target.value = ""; }} /><span><Upload size={14} /> JPEG, PNG, WebP · до 3 МБ · до 5 фото</span></label>{selected && <button className="button subtle" disabled={busy} onClick={remove}><Trash2 size={15} /> Удалить это фото</button>}{busy && <span role="status">Сохраняем…</span>}{photos.length >= maxProductPhotos && <p className="muted">Чтобы добавить новое фото, удалите одно из пяти.</p>}</div>}
    </div>
  </dialog>;
}
