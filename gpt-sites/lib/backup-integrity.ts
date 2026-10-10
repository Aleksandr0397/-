import { InputError } from "./inventory-domain";

export type ArchiveEntry = { path: string; size: number; sha256: string };
export type BackupManifest = { format: "inventory-atoll-archive"; version: 1; entries: ArchiveEntry[] };
export async function digest(bytes: Uint8Array) {
  const hash = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
}
export async function createBackupManifest(parts: Record<string, Uint8Array>): Promise<BackupManifest> {
  const entries: ArchiveEntry[] = [];
  for (const [path, bytes] of Object.entries(parts)) entries.push({ path, size: bytes.byteLength, sha256: await digest(bytes) });
  return { format: "inventory-atoll-archive", version: 1, entries };
}
export function parseBackupManifest(raw: string): BackupManifest {
  let value;
  try { value = JSON.parse(raw); } catch { throw new InputError("Повреждён список файлов резервной копии."); }
  if (value?.format !== "inventory-atoll-archive" || value.version !== 1 || !Array.isArray(value.entries) || value.entries.length > 501) throw new InputError("Неизвестный формат списка файлов копии.");
  const paths = new Set<string>();
  for (const entry of value.entries) {
    if (!entry || typeof entry.path !== "string" || !/^(backup\.json|files\/[A-Za-z0-9:_-]{1,80})$/.test(entry.path) || !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > 16000000 || !/^[a-f0-9]{64}$/.test(entry.sha256) || paths.has(entry.path)) throw new InputError("Неверный список файлов резервной копии.");
    paths.add(entry.path);
  }
  if (!paths.has("backup.json")) throw new InputError("В списке файлов нет backup.json.");
  return value as BackupManifest;
}
export async function verifyBackupPart(manifest: BackupManifest, path: string, bytes: Uint8Array) {
  const expected = manifest.entries.find(entry => entry.path === path);
  if (!expected || expected.size !== bytes.byteLength || expected.sha256 !== await digest(bytes)) throw new InputError("Контрольная сумма не совпала: " + path + ". Восстановление остановлено.");
}
