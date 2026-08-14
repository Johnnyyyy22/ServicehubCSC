import { postToScript, type PostResult } from "./dispatch-api";

export const LOCK_KEY = "dispatch.lock";
export const QUEUE_KEY = "dispatch.queue";

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

export function enqueue(item: Omit<QueueItem, "id" | "attempts" | "acked" | "nextAt">) {
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
export async function sendQueueItem(item: QueueItem): Promise<PostResult | null> {
  try {
    const result = await postToScript({
      row: item.row,
      action: item.action,
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
      q.id === item.id ? { ...q, attempts, nextAt: Date.now() + backoffFor(attempts) } : q,
    );
    writeQueue(queue);
  }

  return queue;
}

export function hasStalledItems(queue: QueueItem[]) {
  return queue.some((item) => item.attempts >= MAX_ATTEMPTS);
}