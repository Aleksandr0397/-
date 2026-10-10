import { digest } from "./backup-integrity";
type StorageAccess = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export type MutationAttempt<T> = { key: string; fingerprint: string; scope: string; payload: T };
export function pendingMutation<T>(scope: string, storage?: StorageAccess): MutationAttempt<T> | null {
  try {
    const value = JSON.parse(storage?.getItem("atoll-mutation-v1:" + scope) ?? "null");
    return value?.scope === scope && typeof value.fingerprint === "string" && /^[0-9a-f-]{36}$/i.test(value.key) && value.payload && typeof value.payload === "object" ? value : null;
  } catch { return null; }
}
export async function mutationAttempt<T>(scope: string, payload: T, storage?: StorageAccess, previous?: MutationAttempt<T> | null) {
  const fingerprint = await digest(new TextEncoder().encode(JSON.stringify(payload)));
  const candidate = pendingMutation<T>(scope, storage) ?? previous;
  const attempt: MutationAttempt<T> = { key: candidate?.scope === scope && candidate.fingerprint === fingerprint ? candidate.key : crypto.randomUUID(), scope, fingerprint, payload };
  try { storage?.setItem("atoll-mutation-v1:" + scope, JSON.stringify(attempt)); } catch { /* Retained in component memory. */ }
  return attempt;
}
export function completeMutation(attempt: MutationAttempt<unknown>, storage?: StorageAccess) {
  try { if (pendingMutation(attempt.scope, storage)?.key === attempt.key) storage?.removeItem("atoll-mutation-v1:" + attempt.scope); } catch { /* Saved server record is authoritative. */ }
}
