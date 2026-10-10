export type Product = { id: string; code: string; brand: string; name: string; stock: number | null; priceCents: number; sourceName: string; sourceType: string; leadDays: number | null; warehouse?: string; bin?: string; minStock?: number };
export type CartLine = Product & { quantity: number };
export type User = { id: string; name: string; email: string; role: string; discountBps: number };
export type SiteInfo = { user: User | null; price: { filename: string; created_at: string; row_count: number } | null; productCount: number };
export type Order = { id: string; created_at: string; status: string; total_cents: number; comment: string; customer_name?: string; customer_email?: string; items: { product_id: string; code: string; brand: string; name: string; quantity: number; unit_price_cents: number }[] };
export const money = (cents: number) => new Intl.NumberFormat("ru-RU", { style: "currency", currency: "RUB", maximumFractionDigits: cents % 100 ? 2 : 0 }).format(cents / 100);
export const date = (value: string) => new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Volgograd" }).format(new Date(value));
export const statuses: Record<string, string> = { new: "Новый", processing: "В работе", ready: "Готов к выдаче", completed: "Завершён", cancelled: "Отменён" };
export class ApiError extends Error { constructor(message: string, public status: number) { super(message); } }
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, cache: "no-store" });
  const data = await response.json() as T & { error?: string };
  if (!response.ok) throw new ApiError(data.error ?? "Операция не завершена.", response.status);
  return data as T;
}
export const send = (method: string, data: unknown): RequestInit => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
