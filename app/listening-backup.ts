import { CODIO_ONBOARDING_KEY } from "./codio-onboarding";
import { LISTENING_MEMORY_KEY } from "./listening-intelligence";

// Everything CODIO learns lives in this browser profile. A backup moves the
// listening memory, played history and settings to another computer or a fresh
// install. Credentials and the device-local QQ authorization flag stay out.

export const LISTENING_BACKUP_VERSION = 1 as const;
export const BACKUP_KEYS = [
  LISTENING_MEMORY_KEY,
  "codio-played-history",
  "codio-search-history",
  "tide-preferences",
  "codio-qq-taste-profile",
  "codio-weather-location",
  CODIO_ONBOARDING_KEY,
] as const;
export const BACKUP_KEY_PREFIXES = ["codio-recommendation-pool-v1-"] as const;
const MAX_ENTRY_BYTES = 6 * 1024 * 1024;

export type ListeningBackup = {
  app: "codio";
  version: typeof LISTENING_BACKUP_VERSION;
  exportedAt: string;
  entries: Record<string, string>;
};

type ReadableStorage = { length: number; key: (index: number) => string | null; getItem: (key: string) => string | null };

export function isBackupKey(key: string) {
  return (BACKUP_KEYS as readonly string[]).includes(key) || BACKUP_KEY_PREFIXES.some((prefix) => key.startsWith(prefix));
}

export function buildListeningBackup(storage: ReadableStorage, now = new Date()): ListeningBackup {
  const entries: Record<string, string> = {};
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!key || !isBackupKey(key)) continue;
    const value = storage.getItem(key);
    if (typeof value === "string" && value.length <= MAX_ENTRY_BYTES) entries[key] = value;
  }
  return { app: "codio", version: LISTENING_BACKUP_VERSION, exportedAt: now.toISOString(), entries };
}

export function serializeListeningBackup(backup: ListeningBackup) {
  return JSON.stringify(backup, null, 2);
}

export function backupFileName(now = new Date()) {
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  return `codio-backup-${date}.json`;
}

export class ListeningBackupError extends Error {
  constructor(public readonly code: "BACKUP_INVALID_JSON" | "BACKUP_NOT_CODIO" | "BACKUP_VERSION" | "BACKUP_EMPTY") {
    super(code);
  }
}

export function parseListeningBackup(text: string): ListeningBackup {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ListeningBackupError("BACKUP_INVALID_JSON");
  }
  const record = raw as Partial<ListeningBackup> | null;
  if (!record || typeof record !== "object" || record.app !== "codio" || !record.entries || typeof record.entries !== "object")
    throw new ListeningBackupError("BACKUP_NOT_CODIO");
  if (record.version !== LISTENING_BACKUP_VERSION) throw new ListeningBackupError("BACKUP_VERSION");
  const entries: Record<string, string> = {};
  for (const [key, value] of Object.entries(record.entries)) {
    if (!isBackupKey(key) || typeof value !== "string" || value.length > MAX_ENTRY_BYTES) continue;
    // Every stored value is JSON; refuse anything that would break the reader.
    try { JSON.parse(value); } catch { continue; }
    entries[key] = value;
  }
  if (!Object.keys(entries).length) throw new ListeningBackupError("BACKUP_EMPTY");
  return { app: "codio", version: LISTENING_BACKUP_VERSION, exportedAt: typeof record.exportedAt === "string" ? record.exportedAt : "", entries };
}

export function applyListeningBackup(storage: Pick<Storage, "setItem">, backup: ListeningBackup) {
  const keys = Object.keys(backup.entries);
  for (const key of keys) storage.setItem(key, backup.entries[key]);
  return { applied: keys.length, keys };
}

export function describeListeningBackup(backup: ListeningBackup) {
  const count = Object.keys(backup.entries).length;
  const memory = backup.entries[LISTENING_MEMORY_KEY];
  let events = 0;
  if (memory) {
    try {
      const parsed = JSON.parse(memory) as { events?: unknown[] };
      events = Array.isArray(parsed.events) ? parsed.events.length : 0;
    } catch {
      events = 0;
    }
  }
  const date = backup.exportedAt ? backup.exportedAt.slice(0, 10) : "";
  return `${count} 项记录${events ? ` · ${events} 条听歌记忆` : ""}${date ? ` · ${date}` : ""}`;
}
