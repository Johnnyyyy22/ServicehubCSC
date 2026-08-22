export const SHEET_URL =
  "https://script.google.com/macros/s/AKfycbyW4tvXHQYZ3MqlQXmqxm2WMjY1ohf2eoiY2-ZwPDYhBCx9wD15RUuW7uCmf8ALQnGE/exec";

/** Apps Script Web App endpoint (alias kept short for call sites). */
export const API = SHEET_URL;

export type Row = unknown[];

export const STATUS_OPTIONS = [
  "Running Good",
  "Unresponded / Backlog",
  "Not Running / Running with Parts for Replacement",
] as const;
export type StatusOption = (typeof STATUS_OPTIONS)[number];

/** Status values the Apps Script should email the dispatcher about. */
export const NOTIFY_STATUSES = [
  "Running Good",
  "Not Running / Running with Parts for Replacement",
  "Unresponded",
  "Backlog",
] as const;

export function shouldNotifyStatus(status: string): boolean {
  const value = status.trim().toLowerCase();
  return NOTIFY_STATUSES.some((s) => s.toLowerCase() === value);
}

export type Engineer = { id: string; name: string; email: string };

/** Reads the signed-in engineer from localStorage, or null. */
export function getEngineer(): Engineer | null {
  if (typeof localStorage === "undefined") return null;
  const id =
    localStorage.getItem("EngineerID") ??
    localStorage.getItem("engineerID") ??
    "";
  if (!id.trim()) return null;
  return {
    id,
    name:
      localStorage.getItem("EngineerName") ??
      localStorage.getItem("engineerName") ??
      "",
    email:
      localStorage.getItem("engineerEmail") ??
      localStorage.getItem("EngineerEmail") ??
      "",
  };
}

function toRows(data: unknown): Row[] {
  if (!Array.isArray(data)) {
    if (data && typeof data === "object") {
      const obj = data as Record<string, unknown>;
      for (const key of ["data", "rows", "records", "result", "values"]) {
        if (Array.isArray(obj[key])) return toRows(obj[key]);
      }
    }
    return [];
  }
  return data.map((r) =>
    Array.isArray(r) ? (r as Row) : Object.values(r as Record<string, unknown>),
  );
}

function isBlank(row: Row) {
  return row.every((c) => String(c ?? "").trim() === "");
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * fetch() with a hard timeout via AbortController. Plain fetch() has no
 * built-in timeout — on a weak-but-not-fully-dead signal (the realistic
 * "no internet" case in the field: radio on, no real connectivity) it can
 * hang for a long time before the browser gives up on its own, well past
 * what an engineer standing at a client site will wait for. Aborting after
 * a few seconds means a dead connection fails FAST and falls through to
 * the offline queue immediately, instead of leaving the UI looking frozen.
 */
async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  ms = 6000,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Races a promise against a timeout, throwing if the timeout wins. Used so
 * a dead connection doesn't leave the login screen hanging through
 * fetchLoginRows' full internal retry sequence before falling back to an
 * offline sign-in. */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

async function getRows(params: Record<string, string> = {}): Promise<Row[]> {
  const qs = new URLSearchParams({ ...params, t: String(Date.now()) });
  const res = await fetchWithTimeout(`${SHEET_URL}?${qs}`);
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("The data source did not return JSON.");
  }
  return toRows(parsed).filter((r) => !isBlank(r));
}

/**
 * Pings the Apps Script and WAITS for it to respond before returning.
 * This ensures the script is fully awake before the login fetch fires.
 * Times out after 8 seconds — if the ping itself fails or times out,
 * we proceed anyway (better a slow login than a broken one).
 */
async function warmUpScript(): Promise<void> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    await fetch(`${SHEET_URL}?ping=1&t=${String(Date.now())}`, {
      signal: controller.signal,
    });
    clearTimeout(timer);
  } catch {
    // Ping failed or timed out — proceed anyway, login will retry on empty result.
  }
}

/**
 * Fetches Google's server clock and returns the offset (ms) to add to
 * `Date.now()` so the app's displayed "now" reflects real time even if
 * the phone's own clock has been changed. Returns null on failure (the
 * caller should just keep using whatever offset it already had, or 0).
 *
 * Deliberately cheap: reuses the same ?ping=1 endpoint already used to
 * keep the script warm, just reads the serverTime field it returns.
 * Round-trip latency is not compensated for — for a clock display this
 * granularity is unnecessary, and the periodic re-sync (see dispatch.tsx)
 * keeps any small error from accumulating.
 */
export async function getServerTimeOffset(): Promise<number | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(`${SHEET_URL}?ping=1&t=${String(Date.now())}`, {
      signal: controller.signal,
    });
    clearTimeout(timer);
    const data = (await res.json()) as { serverTime?: number };
    if (typeof data.serverTime !== "number" || !data.serverTime) return null;
    return data.serverTime - Date.now();
  } catch {
    return null;
  }
}

/** Users tab: [EngineerID, EngineerName, Username, Password]
 *
 * Strategy:
 * 1. Warm up the script first (await the ping — not fire-and-forget).
 * 2. Fetch the Users tab. If the result is empty (script was still cold
 *    despite the ping), wait 2 seconds and try once more.
 * 3. Return the rows, skipping a header row if present.
 *
 * This eliminates both the "Checking..." hang and the false
 * "Invalid login" on first click caused by Apps Script cold starts.
 */
export async function fetchLoginRows(): Promise<Row[]> {
  // Step 1: wait for the script to wake up before attempting the real fetch.
  await warmUpScript();

  // Step 2: fetch with one automatic retry on empty result.
  let rows = await getRows({ sheet: "Users tab" }).catch(() => [] as Row[]);

  if (!rows.length) {
    // Script may still be warming — wait 2s and try once more.
    await sleep(2000);
    rows = await getRows({ sheet: "Users tab" });
  }

  // Fallback: try default sheet if Users tab returned nothing at all.
  if (!rows.length) rows = await getRows();

  // Skip header row if present.
  if (
    rows.length &&
    String(rows[0]?.[0] ?? "")
      .toLowerCase()
      .includes("engineer")
  ) {
    return rows.slice(1);
  }
  return rows;
}

export type DispatchJob = {
  rowId: string;
  engineerId: string;
  engineer: string;
  account: string;
  model: string;
  purpose: string;
  remarks: string;
  status: string;
  logIn: string;
  logOut: string;
  /** Raw value of the sheet's Date column, unparsed. Use dayKey() to compare. */
  date: string;
};

/**
 * Normalizes a date-ish value (a sheet cell or a JS Date) to a "YYYY-MM-DD"
 * key using LOCAL time, so same-day comparisons aren't thrown off by the UTC
 * offset in Apps Script's ISO strings. Returns "" when the value is blank or
 * can't be parsed — callers should treat that as "unknown" and fail open
 * (i.e. still show the row) rather than silently hiding real assignments.
 */
export function dayKey(value: string | Date): string {
  const d = value instanceof Date ? value : new Date(String(value).trim());
  if (isNaN(d.getTime())) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Fixed column layout returned by the Apps Script's doGet(), which always
 * starts reading at sheet row 2 (columns A-L): Date, Engineer ID, EE Name,
 * Area, Account, Machine Model, Purpose, Remarks, STATUS, LOG IN, LOG OUT,
 * TIME SPENT. The header row (row 1) is never included in the response,
 * so column order is guaranteed and jobs are always read by fixed
 * position here.
 */
const COL = {
  date: 0,
  engineerId: 1,
  engineer: 2,
  area: 3,
  account: 4,
  model: 5,
  purpose: 6,
  remarks: 7,
  status: 8,
  logIn: 9,
  logOut: 10,
  timeSpent: 11,
} as const;

/** Daily Dispatch tab */
export async function fetchDispatchJobs(): Promise<DispatchJob[]> {
  const rows = await getRows({ sheet: "Daily Dispatch" });
  if (!rows.length) return [];

  const pick = (row: Row, i: number) =>
    i >= 0 ? String(row[i] ?? "").trim() : "";

  // Time values from the sheet arrive as ISO strings (e.g. "2026-08-12T07:49:57.000Z")
  // after a refresh or sign-out. Format them back to a readable 12-hour time so the
  // app displays "3:49:57 PM" instead of the raw UTC string.
  const pickTime = (row: Row, i: number): string => {
    if (i < 0) return "";
    const raw = row[i];
    if (!raw) return "";
    const s = String(raw).trim();
    if (!s) return "";
    const d = new Date(s);
    if (!isNaN(d.getTime())) {
      return d.toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: true,
      });
    }
    // Already a formatted time string (e.g. "3:49:57 PM") — return as-is.
    return s;
  };

  return rows.map((row, i) => ({
    // rows[0] is sheet row 2 (the Apps Script's doGet() already strips the
    // header row before this array reaches us). The write endpoint's
    // doPost() computes `r = Number(p.row) + 1` — it already adds its own
    // +1 to convert this into a real sheet row. So rowId = i+1 is correct:
    // i=0 -> rowId "1" -> backend r = 2 (sheet row 2). Do NOT change this
    // to i+2 without also removing the backend's own +1, or every write
    // will land one row past its target.
    rowId: String(i + 1),
    engineerId: pick(row, COL.engineerId),
    engineer: pick(row, COL.engineer),
    account: pick(row, COL.account),
    model: pick(row, COL.model),
    purpose: pick(row, COL.purpose),
    remarks: pick(row, COL.remarks),
    status: pick(row, COL.status),
    logIn: pickTime(row, COL.logIn),
    logOut: pickTime(row, COL.logOut),
    date: pick(row, COL.date),
  }));
}

export type PostResult = {
  /** The request reached the script and it did not report a conflict. */
  ok: boolean;
  /** Raw result string echoed by the script ("ok", "ALREADY_LOGGED_IN", …). */
  result: string;
  /** Whether the script echoed notify:"ok" for the Gmail notification. */
  notified: boolean;
  /** False when the response was opaque (no-cors fallback) and can't be read. */
  acked: boolean;
};

export const CONFLICT = "ALREADY_LOGGED_IN";
/** The backend couldn't find a row matching this engineer + account —
 * the schedule changed since this job list loaded. The write was
 * refused rather than risk landing on someone else's row. */
export const ROW_NOT_FOUND = "ROW_NOT_FOUND";

/**
 * Single POST helper for every script call. Always attaches the engineer's
 * identity and an explicit notify flag. Falls back to an opaque no-cors
 * request when CORS blocks reading the response.
 */
export async function postToScript(
  params: Record<string, string | number | undefined>,
): Promise<PostResult> {
  const engineer = getEngineer();
  const identity: Engineer = engineer ?? { id: "", name: "", email: "" };

  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") body.set(key, String(value));
  }
  body.set("engineer", JSON.stringify(identity));
  body.set("engineerId", identity.id);
  body.set("engineerName", identity.name);
  body.set("engineerEmail", identity.email);

  try {
    const res = await fetchWithTimeout(API, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const text = await res.text();
    let result = text.trim();
    let notified = false;
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      result = String(parsed["result"] ?? parsed["status"] ?? result);
      notified = String(parsed["notify"] ?? "").toLowerCase() === "ok";
    } catch {
      notified = /notify\s*[:=]\s*"?ok/i.test(text);
    }
    const conflict = result.toUpperCase().includes(CONFLICT);
    const notFound = result.toUpperCase().includes(ROW_NOT_FOUND);
    return {
      ok: res.ok && !conflict && !notFound,
      result: conflict ? CONFLICT : notFound ? ROW_NOT_FOUND : result,
      notified,
      acked: true,
    };
  } catch {
    // Opaque fallback: on some networks the main request fails (CORS,
    // preflight quirks) even though the script would have received it.
    // Try once more, no-cors, but with the SAME timeout guard — if the
    // connection is actually dead, this must not hang either. Any
    // failure here (including a timeout) propagates up so the caller
    // queues the write for later instead of waiting forever.
    await fetchWithTimeout(
      API,
      {
        method: "POST",
        mode: "no-cors",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      },
      6000,
    );
    return { ok: true, result: "sent", notified: false, acked: false };
  }
}

export function stampTime(at: Date = new Date()) {
  return at.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
}

export async function updateJobStatus(
  rowId: string,
  status: StatusOption,
  account: string,
  machine: string,
) {
  return postToScript({
    row: rowId,
    action: "status",
    status,
    account,
    machine,
    notify: shouldNotifyStatus(status) ? 1 : 0,
  });
}

export async function logJobTime(
  rowId: string,
  action: "login" | "logout",
  account: string,
  machine: string,
  status?: string,
  force?: boolean,
  // Set true ONLY when `time`/`at` reflects something that genuinely
  // happened earlier while the device was offline (a queued/replayed
  // item) — see dispatch-store.ts's sendQueueItem and dispatch.tsx's
  // login-replay. The backend trusts the device clock ONLY when this is
  // set, and clamps it to a plausible window even then. A live,
  // connected-right-now tap (offlineCapture left false) always gets
  // timestamped by the server's own clock — the phone's clock is never
  // consulted for that case, which is what stops "change my phone's
  // time, then tap Log Out" from working while the device is actually
  // online.
  offlineCapture?: boolean,
  // Optional explicit timestamp to send instead of "now" — used for the
  // login-replay path, where the real moment of login is the local lock's
  // original ts, not whenever the replay happens to run.
  at?: Date,
) {
  const now = at ?? new Date();
  return postToScript({
    row: rowId,
    action,
    account,
    machine,
    time: stampTime(now),
    atMs: now.getTime(),
    ...(action === "logout" ? { date: now.toLocaleDateString("en-US") } : {}),
    ...(status ? { status } : {}),
    ...(force ? { force: 1 } : {}),
    ...(offlineCapture ? { offlineCapture: 1 } : {}),
    notify: 1,
  });
}
