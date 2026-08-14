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
  const id = localStorage.getItem("EngineerID") ?? localStorage.getItem("engineerID") ?? "";
  if (!id.trim()) return null;
  return {
    id,
    name: localStorage.getItem("EngineerName") ?? localStorage.getItem("engineerName") ?? "",
    email: localStorage.getItem("engineerEmail") ?? localStorage.getItem("EngineerEmail") ?? "",
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

async function getRows(params: Record<string, string> = {}): Promise<Row[]> {
  const qs = new URLSearchParams({ ...params, t: String(Date.now()) });
  const res = await fetch(`${SHEET_URL}?${qs}`);
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
  if (rows.length && String(rows[0]?.[0] ?? "").toLowerCase().includes("engineer")) {
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
};

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

  const pick = (row: Row, i: number) => (i >= 0 ? String(row[i] ?? "").trim() : "");

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
    const res = await fetch(API, {
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
    return { ok: res.ok && !conflict, result: conflict ? CONFLICT : result, notified, acked: true };
  } catch {
    // Opaque fallback: the write still lands, we just cannot read the echo.
    await fetch(API, {
      method: "POST",
      mode: "no-cors",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
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

export async function updateJobStatus(rowId: string, status: StatusOption) {
  return postToScript({
    row: rowId,
    action: "status",
    status,
    notify: shouldNotifyStatus(status) ? 1 : 0,
  });
}

export async function logJobTime(
  rowId: string,
  action: "login" | "logout",
  status?: string,
  force?: boolean,
) {
  const now = new Date();
  return postToScript({
    row: rowId,
    action,
    time: stampTime(now),
    ...(action === "logout" ? { date: now.toLocaleDateString("en-US") } : {}),
    ...(status ? { status } : {}),
    ...(force ? { force: 1 } : {}),
    notify: 1,
  });
}
