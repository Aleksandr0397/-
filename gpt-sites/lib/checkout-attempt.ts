type StorageAccess = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export type CheckoutPayload = { comment: string; channel: string; payFromBalance: boolean; items: { productId: string; quantity: number; expectedPriceCents: number }[] };
export type CheckoutAttempt = { key: string; fingerprint: string; storageKey: string; payload: CheckoutPayload };
export function pendingCheckout(customerId: string, storage?: StorageAccess): CheckoutAttempt | null {
  try {
    const value = JSON.parse(storage?.getItem("atoll-checkout-v1:" + customerId) ?? "null");
    if (!value || typeof value.key !== "string" || typeof value.fingerprint !== "string" || value.storageKey !== "atoll-checkout-v1:" + customerId) return null;
    const payload = value.payload;
    if (!payload || typeof payload.comment !== "string" || payload.comment.length > 2000 || !["online", "pos"].includes(payload.channel) || typeof payload.payFromBalance !== "boolean" || !Array.isArray(payload.items) || payload.items.length > 80) return null;
    if (payload.items.some((item: CheckoutPayload["items"][number]) => typeof item?.productId !== "string" || !Number.isSafeInteger(item.quantity) || !Number.isSafeInteger(item.expectedPriceCents))) return null;
    return value;
  } catch { return null; }
}
export async function checkoutAttempt(customerId: string, payload: CheckoutPayload, storage?: StorageAccess, previous?: CheckoutAttempt | null): Promise<CheckoutAttempt> {
  const canonical = JSON.stringify({ ...payload, items: [...payload.items].sort((a, b) => a.productId.localeCompare(b.productId)) });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  const fingerprint = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, "0")).join("");
  const storageKey = "atoll-checkout-v1:" + customerId;
  const candidate = pendingCheckout(customerId, storage) ?? previous;
  const key = candidate?.storageKey === storageKey && candidate?.fingerprint === fingerprint && typeof candidate.key === "string" && /^[0-9a-f-]{36}$/i.test(candidate.key) ? candidate.key : crypto.randomUUID();
  const attempt = { key, fingerprint, storageKey, payload };
  try { storage?.setItem(storageKey, JSON.stringify(attempt)); } catch { /* Keep the same attempt in memory if storage is unavailable. */ }
  return attempt;
}
export function completeCheckout(attempt: CheckoutAttempt, storage?: StorageAccess) {
  try {
    const stored = JSON.parse(storage?.getItem(attempt.storageKey) ?? "null");
    if (stored?.key === attempt.key) storage?.removeItem(attempt.storageKey);
  } catch { /* The server's saved order remains authoritative. */ }
}
