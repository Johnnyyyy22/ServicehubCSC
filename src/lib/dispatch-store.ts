import {
  postToScript,
  type PostResult,
  type DispatchJob,
} from "./dispatch-api";

export const LOCK_KEY = "dispatch.lock";
export const QUEUE_KEY = "dispatch.queue";
export const JOBS_CACHE_KEY = "dispatch.jobsCache";

export type LockEntry = {
  row: string;
  engineerId: string;
  engineerName: string;
  engineerEmail: string;
  accountCode: string;
  ts: number;
  syncedAt?: number;
};

export type LockMap = Record<string, LockEntry>;

function readJson<T>(key: string, fallback: T): T {
  if (typeof localStorage === "undefined") return fallback;
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown) {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* quota or private mode — locks degrade to in-memory only */
  }
}

/* --------------------------- jobs cache --------------------------- */
/**
 * The loaded dispatch list, persisted to localStorage — not just kept in
 * React state. This is what actually makes "load your 3 jobs before you
 * leave, work all day with zero signal" hold up: React state alone lives
 * only in memory, and mobile browsers routinely kill or reload a
 * backgrounded tab hours into a shift to save memory. Without this, an
 * engineer who locks their phone at client 2 could come back to client 3
 * with an empty dispatch list, no different from the load() bug that
 * used to wipe it on a failed refresh.
 *
 * Scoped to a specific day + engineer so it can't leak into a new day's
 * dispatch or another engineer sharing the device.
 */
export type JobsCacheEntry = {
  day: string;
  engineerId: string;
  jobs: DispatchJob[];
  loginTimes: Record<string, string>;
  logoutTimes: Record<string, string>;
  cachedAt: number;
};

export function readJobsCache(): JobsCacheEntry | null {
  return readJson<JobsCacheEntry | null>(JOBS_CACHE_KEY, null);
}

export function writeJobsCache(entry: JobsCacheEntry) {
  writeJson(JOBS_CACHE_KEY, entry);
}

export function clearJobsCache() {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.removeItem(JOBS_CACHE_KEY);
  } catch {
    /* ignore */
  }
}

/* ------------------------- offline credentials ------------------------- */
/**
 * Lets an engineer sign in with zero connectivity — but only on a device
 * that has already signed in successfully at least once while online.
 * There's no way around that constraint: validating a password against a
 * remote sheet requires reaching that sheet at least once, so a brand-new
 * phone's very first login still needs a moment of real signal.
 *
 * The password itself is never cached — only a SHA-256 hash of it, keyed
 * by username. This is weaker than a proper server-side salted hash (the
 * Users tab stores plaintext passwords, which this app doesn't control),
 * but it means a lost or inspected phone doesn't hand over anyone's real
 * password in the clear.
 */
const OFFLINE_CREDS_KEY = "dispatch.offlineCreds";

type OfflineCredEntry = {
  passwordHash: string;
  engineerId: string;
  engineerName: string;
  engineerEmail: string;
};

async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Call this right after a successful ONLINE login. */
export async function cacheOfflineCredential(
  username: string,
  password: string,
  engineerId: string,
  engineerName: string,
  engineerEmail: string,
): Promise<void> {
  if (typeof crypto === "undefined" || !crypto.subtle) return; // requires HTTPS/localhost
  const key = username.trim().toLowerCase();
  if (!key) return;
  const passwordHash = await sha256Hex(password);
  const all = readJson<Record<string, OfflineCredEntry>>(OFFLINE_CREDS_KEY, {});
  all[key] = { passwordHash, engineerId, engineerName, engineerEmail };
  writeJson(OFFLINE_CREDS_KEY, all);
}

/**
 * Checks a login attempt against the cached credential for this username.
 * Returns the cached engineer identity on a match, or null if there's no
 * cached entry for this username or the password doesn't match it.
 */
export async function verifyOfflineCredential(
  username: string,
  password: string,
): Promise<OfflineCredEntry | null> {
  if (typeof crypto === "undefined" || !crypto.subtle) return null;
  const key = username.trim().toLowerCase();
  if (!key) return null;
  const all = readJson<Record<string, OfflineCredEntry>>(OFFLINE_CREDS_KEY, {});
  const entry = all[key];
  if (!entry) return null;
  const hash = await sha256Hex(password);
  return hash === entry.passwordHash ? entry : null;
}

/* ------------------------------- locks ------------------------------- */

export function readLocks(): LockMap {
  return readJson<LockMap>(LOCK_KEY, {});
}

export function setLock(entry: LockEntry): LockMap {
  const locks = { ...readLocks(), [entry.row]: entry };
  writeJson(LOCK_KEY, locks);
  return locks;
}

export function markLockSynced(row: string): LockMap {
  const locks = readLocks();
  const existing = locks[row];
  if (!existing) return locks;
  const next = { ...locks, [row]: { ...existing, syncedAt: Date.now() } };
  writeJson(LOCK_KEY, next);
  return next;
}

export function clearLock(row: string): LockMap {
  const locks = readLocks();
  if (!(row in locks)) return locks;
  const next = { ...locks };
  delete next[row];
  writeJson(LOCK_KEY, next);
  return next;
}

/** Cross-tab sync: fires whenever another tab rewrites the lock map. */
export function subscribeLocks(onChange: (locks: LockMap) => void): () => void {
  const handler = (event: StorageEvent) => {
    if (event.key !== LOCK_KEY && event.key !== null) return;
    onChange(readLocks());
  };
  window.addEventListener("storage", handler);
  return () => window.removeEventListener("storage", handler);
}

/* ------------------------------- queue ------------------------------- */

export type QueueItem = {
  id: string;
  row: string;
  action: "login" | "logout" | "status";
  time: string;
  status?: string;
  engineer: { id: string; name: string; email: string };
  attempts: number;
  acked: boolean;
  nextAt: number;
  notify: number;
  force?: number;
  date?: string;
  account?: string;
  machine?: string;
};

/** 15s, 30s, 1m, 2m, 5m — the last delay repeats until MAX_ATTEMPTS. */
export const BACKOFF_MS = [15_000, 30_000, 60_000, 120_000, 300_000];
export const MAX_ATTEMPTS = 8;

export function backoffFor(attempts: number) {
  return BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length - 1)] ?? 300_000;
}

export function readQueue(): QueueItem[] {
  return readJson<QueueItem[]>(QUEUE_KEY, []);
}

export function writeQueue(items: QueueItem[]) {
  writeJson(QUEUE_KEY, items);
}

export function enqueue(
  item: Omit<QueueItem, "id" | "attempts" | "acked" | "nextAt">,
) {
  const queued: QueueItem = {
    ...item,
    id: `${item.row}-${item.action}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    attempts: 0,
    acked: false,
    nextAt: Date.now(),
  };
  writeQueue([...readQueue(), queued]);
  return queued;
}

export function removeFromQueue(id: string) {
  const next = readQueue().filter((item) => item.id !== id);
  writeQueue(next);
  return next;
}

export function resetQueueBackoff() {
  const next = readQueue().map((item) => ({ ...item, nextAt: Date.now() }));
  writeQueue(next);
  return next;
}

/** Sends one queued item. Returns the script result, or null when it failed. */
export async function sendQueueItem(
  item: QueueItem,
): Promise<PostResult | null> {
  try {
    const result = await postToScript({
      row: item.row,
      action: item.action,
      // account/machine let the backend confirm this row still belongs to
      // this engineer before writing, instead of trusting a row number
      // that may have gone stale while this item sat in the queue.
      account: item.account,
      machine: item.machine,
      time: item.time,
      ...(item.status ? { status: item.status } : {}),
      ...(item.date ? { date: item.date } : {}),
      ...(item.force ? { force: item.force } : {}),
      notify: item.notify,
    });
    return result;
  } catch {
    return null;
  }
}

/**
 * Drains the queue head-first. Items past MAX_ATTEMPTS are left in place and
 * reported back so the UI can offer "Retry now" / "Discard".
 */
export async function flushQueue(
  onItemDone?: (item: QueueItem, result: PostResult) => void,
): Promise<QueueItem[]> {
  let queue = readQueue();
  if (!queue.length) return queue;

  for (const item of [...queue]) {
    if (item.attempts >= MAX_ATTEMPTS) continue;
    if (item.nextAt > Date.now()) continue;

    const result = await sendQueueItem(item);
    if (result?.ok || result?.acked) {
      queue = removeFromQueue(item.id);
      if (result) onItemDone?.(item, result);
      continue;
    }

    const attempts = item.attempts + 1;
    queue = readQueue().map((q) =>
      q.id === item.id
        ? { ...q, attempts, nextAt: Date.now() + backoffFor(attempts) }
        : q,
    );
    writeQueue(queue);
  }

  return queue;
}

export function hasStalledItems(queue: QueueItem[]) {
  return queue.some((item) => item.attempts >= MAX_ATTEMPTS);
}
