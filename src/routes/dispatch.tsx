import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  fetchDispatchJobs,
  updateJobStatus,
  logJobTime,
  getEngineer,
  shouldNotifyStatus,
  stampTime,
  dayKey,
  CONFLICT,
  ROW_NOT_FOUND,
  STATUS_OPTIONS,
  type DispatchJob,
  type StatusOption,
  type Engineer,
} from "@/lib/dispatch-api";
import {
  readLocks,
  setLock,
  clearLock,
  markLockSynced,
  subscribeLocks,
  readQueue,
  writeQueue,
  enqueue,
  flushQueue,
  resetQueueBackoff,
  hasStalledItems,
  MAX_ATTEMPTS,
  type LockMap,
  type QueueItem,
} from "@/lib/dispatch-store";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

export const Route = createFileRoute("/dispatch")({
  head: () => ({
    meta: [
      { title: "Daily Dispatch — Field Engineer Jobs" },
      {
        name: "description",
        content:
          "View your assigned service jobs by account, machine model and purpose, then update machine status after service.",
      },
      { property: "og:title", content: "Daily Dispatch — Field Engineer Jobs" },
      {
        property: "og:description",
        content:
          "View assigned service jobs and update machine status after service.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: DispatchPage,
});

type ActivityEvent = {
  id: string;
  time: string;
  engineer: string;
  account: string;
  event: string;
  ok: boolean;
};

/**
 * Matches the phone formats that actually turn up in the Remarks column:
 * 09171234567, 0917-123-4567, +63 917 123 4567, (049) 502-1234, 8123-4567.
 */
const PHONE_RE =
  /(?:\+63|0)[\d\s\-().]{7,14}\d|\(0\d{2,3}\)[\s-]?\d{3}[\s-]?\d{4}|\b8\d{3}[\s-]\d{4}\b/g;

/**
 * Splits free text into plain strings and tappable tel: links so an engineer
 * can dial the site contact without retyping the number.
 */
function linkifyPhones(text: string) {
  if (!text) return text;
  const out: Array<string | { raw: string; dial: string }> = [];
  let last = 0;
  for (const m of text.matchAll(PHONE_RE)) {
    const raw = m[0].trim();
    const digits = raw.replace(/\D/g, "");
    // Guard against catching order numbers or dates.
    if (digits.length < 7 || digits.length > 13) continue;
    const start = m.index ?? 0;
    if (start > last) out.push(text.slice(last, start));
    out.push({ raw, dial: raw.startsWith("+") ? `+${digits}` : digits });
    last = start + m[0].length;
  }
  if (last === 0) return text;
  if (last < text.length) out.push(text.slice(last));
  return out.map((part, i) =>
    typeof part === "string" ? (
      part
    ) : (
      <a
        key={i}
        href={`tel:${part.dial}`}
        onClick={(e) => e.stopPropagation()}
        className="font-medium text-accent-300 underline underline-offset-2"
      >
        {part.raw}
      </a>
    ),
  );
}

/** Formats a millisecond duration as "1h 17m" / "43m" / "16s". */
function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m) return `${m}m ${String(sec).padStart(2, "0")}s`;
  return `${sec}s`;
}

function DispatchPage() {
  const navigate = useNavigate();
  const [engineer, setEngineer] = useState<Engineer | null>(null);
  const [jobs, setJobs] = useState<DispatchJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState<string | null>(null);
  const [now, setNow] = useState<Date | null>(null);
  const [loginTimes, setLoginTimes] = useState<Record<string, string>>({});
  const [logoutTimes, setLogoutTimes] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [loginAt, setLoginAt] = useState<Record<string, number>>({});
  const [duration, setDuration] = useState<Record<string, string>>({});
  const [picked, setPicked] = useState<Record<string, StatusOption>>({});
  const [locks, setLocks] = useState<LockMap>({});
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [offline, setOffline] = useState(false);
  const [activity, setActivity] = useState<ActivityEvent[]>([]);
  const [completedOpen, setCompletedOpen] = useState(false);
  const inFlight = useRef<
    Map<string, Omit<QueueItem, "id" | "attempts" | "acked" | "nextAt">>
  >(new Map());
  const forced = useRef<Set<string>>(new Set());
  // Tracks the calendar day the screen is currently showing, so a midnight
  // rollover can be detected and the board reset for the new day's dispatch.
  const shownDay = useRef<string>(dayKey(new Date()));

  const lockedRow = Object.keys(locks)[0] ?? null;
  const activeJob =
    lockedRow ?? Object.keys(loginTimes).find((r) => !logoutTimes[r]) ?? null;
  const stalled = hasStalledItems(queue);

  const logActivity = useCallback(
    (account: string, event: string, ok: boolean) => {
      setActivity((prev) =>
        [
          {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            time: stampTime(),
            engineer: engineer?.name || "Engineer",
            account: account || "—",
            event,
            ok,
          },
          ...prev,
        ].slice(0, 5),
      );
    },
    [engineer],
  );

  /* ---------------------------- clock ---------------------------- */
  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  /* ------------------------- boot: identity ------------------------- */
  useEffect(() => {
    const found = getEngineer();
    if (!found) {
      navigate({ to: "/" });
      return;
    }
    setEngineer(found);
    setLocks(readLocks());
    setQueue(readQueue());
    setOffline(typeof navigator !== "undefined" && !navigator.onLine);
  }, [navigate]);

  /* ---------------------- cross-tab lock sync ---------------------- */
  useEffect(() => subscribeLocks(setLocks), []);

  /* --------------------- online / offline / exit --------------------- */
  const drain = useCallback(async () => {
    const remaining = await flushQueue((item, result) => {
      logActivity(
        item.account ?? "",
        `${item.action} synced`,
        result.notified || result.ok,
      );
      if (item.action === "logout") clearLock(item.row);
      else markLockSynced(item.row);
    });
    setQueue(remaining);
    setLocks(readLocks());
  }, [logActivity]);

  useEffect(() => {
    const onOnline = () => {
      setOffline(false);
      void drain();
    };
    const onOffline = () => setOffline(true);
    const onExit = () => {
      // Any request still in flight is persisted so it survives the crash.
      for (const pending of inFlight.current.values()) enqueue(pending);
      inFlight.current.clear();
    };
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    window.addEventListener("beforeunload", onExit);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("beforeunload", onExit);
    };
  }, [drain]);

  /* ------------------------ background retry ------------------------ */
  useEffect(() => {
    const t = setInterval(() => {
      if (typeof navigator !== "undefined" && !navigator.onLine) return;
      if (!readQueue().length) return;
      void drain();
    }, 15_000);
    return () => clearInterval(t);
  }, [drain]);

  /* ----------------------------- loading ----------------------------- */
  const load = useCallback(async (id: string, name: string) => {
    setLoading(true);
    setError("");
    try {
      const all = await fetchDispatchJobs();
      const idKey = id.trim().toLowerCase();
      const nameKey = name.trim().toLowerCase();
      const todayKey = dayKey(new Date());
      const mine = all.filter((j) => {
        const isMine =
          j.engineerId.trim().toLowerCase() === idKey ||
          j.engineer.trim().toLowerCase() === nameKey;
        const hasContent = Boolean(j.account || j.model || j.purpose);
        // Only show today's dispatch. If a row's date is blank or doesn't
        // parse, show it anyway rather than risk hiding real assigned work.
        const rowDay = j.date ? dayKey(j.date) : "";
        const isToday = !rowDay || rowDay === todayKey;
        return isMine && hasContent && isToday;
      });
      setJobs(mine);

      // The sheet is the source of truth. Seed the in/out stamps from it so a
      // refresh or a fresh sign-in doesn't show finished jobs as "Not started".
      const sheetIn: Record<string, string> = {};
      const sheetOut: Record<string, string> = {};
      for (const j of mine) {
        const i = j.logIn?.trim();
        const o = j.logOut?.trim();
        if (i) sheetIn[j.rowId] = i;
        if (o) sheetOut[j.rowId] = o;
      }
      // Locally-recorded stamps win: a queued offline event isn't on the sheet
      // yet, and overwriting it here would make the job look un-started.
      setLoginTimes((t) => ({ ...sheetIn, ...t }));
      setLogoutTimes((t) => ({ ...sheetOut, ...t }));

      return mine;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load jobs.");
      setJobs([]);
      return [];
    } finally {
      setLoading(false);
    }
  }, []);

  /* ------------- boot: reconcile locks against the sheet ------------- */
  const reconcile = useCallback(
    async (rows: DispatchJob[]) => {
      const current = readLocks();
      if (!Object.keys(current).length) return;

      for (const [row, lock] of Object.entries(current)) {
        const job = rows.find((j) => j.rowId === row);
        const hasIn = Boolean(job?.logIn?.trim());
        const hasOut = Boolean(job?.logOut?.trim());

        if (hasIn && !hasOut) {
          // Half-finished engagement — resume it.
          setLoginTimes((t) => ({
            ...t,
            [row]: job?.logIn || stampTime(new Date(lock.ts)),
          }));
          setLoginAt((t) => ({ ...t, [row]: lock.ts }));
          continue;
        }
        if (hasIn && hasOut) {
          clearLock(row);
          continue;
        }
        // Log in never landed on the sheet — replay it once with force:1.
        if (!forced.current.has(row)) {
          forced.current.add(row);
          setLoginTimes((t) => ({ ...t, [row]: stampTime(new Date(lock.ts)) }));
          setLoginAt((t) => ({ ...t, [row]: lock.ts }));
          const result = await logJobTime(
            row,
            "login",
            job?.account ?? lock.accountCode,
            job?.model ?? "",
            undefined,
            true,
          );
          if (result.result === CONFLICT) {
            clearLock(row);
            toast.warning("Another engineer is on this job — please refresh.", {
              className: "border-amber-500",
            });
          } else if (result.result === ROW_NOT_FOUND) {
            clearLock(row);
            toast.warning(
              "Couldn't recover this login — the schedule changed. Please refresh.",
              { className: "border-amber-500" },
            );
          } else {
            markLockSynced(row);
            logActivity(
              lock.accountCode,
              "login recovered",
              result.notified || result.acked,
            );
          }
        }
      }
      setLocks(readLocks());
    },
    [logActivity],
  );

  useEffect(() => {
    if (!engineer) return;
    void load(engineer.id, engineer.name).then(reconcile);
  }, [engineer, load, reconcile]);

  /* ------------------------ midnight rollover ------------------------ */
  useEffect(() => {
    if (!now || !engineer) return;
    const key = dayKey(now);
    if (key === shownDay.current) return;
    shownDay.current = key;
    // A new calendar day means a fresh dispatch. Clear yesterday's board —
    // but keep any job the engineer is actively logged into right now, so a
    // shift that happens to cross midnight doesn't lose its start time.
    setLoginTimes((t) => {
      const kept: Record<string, string> = {};
      for (const row of Object.keys(locks)) if (t[row]) kept[row] = t[row];
      return kept;
    });
    setLoginAt((t) => {
      const kept: Record<string, number> = {};
      for (const row of Object.keys(locks)) if (t[row]) kept[row] = t[row];
      return kept;
    });
    setLogoutTimes({});
    setDuration({});
    setPicked({});
    setExpanded({});
    setCompletedOpen(false);
    void load(engineer.id, engineer.name);
  }, [now, engineer, locks, load]);

  /* ----------------------------- actions ----------------------------- */
  /**
   * Re-checks, right before a write, that a job for this engineer + account
   * still exists SOMEWHERE in the sheet — not necessarily at this exact row
   * position. The backend now self-heals position drift on its own (see
   * locateRow_ in the Apps Script), so this check mirrors that: it's not
   * "is the row still at rowId", it's "does this engineer still have this
   * job at all". This is what actually caused Bautista's login time to
   * land on Barasan's row — the sheet shifted under a cached position —
   * and it's now handled on both ends.
   *
   * Fails OPEN on a network error (no verdict either way — the engineer
   * still needs to work with poor signal, and the offline queue is the
   * real safety net there). Fails CLOSED only when no matching row exists
   * anywhere for this engineer + account.
   */
  async function verifyRowOwnership(job: DispatchJob): Promise<boolean> {
    if (!engineer) return false;
    if (offline) return true; // can't verify without signal; queue handles it
    try {
      const fresh = await fetchDispatchJobs();
      const idKey = engineer.id.trim().toLowerCase();
      const nameKey = engineer.name.trim().toLowerCase();
      const accKey = job.account.trim().toLowerCase();
      return fresh.some((row) => {
        const isMine =
          row.engineerId.trim().toLowerCase() === idKey ||
          row.engineer.trim().toLowerCase() === nameKey;
        return isMine && row.account.trim().toLowerCase() === accKey;
      });
    } catch {
      return true;
    }
  }

  async function handleStatus(job: DispatchJob, status: StatusOption) {
    if (!engineer) return;
    setSaving(job.rowId);
    setError("");
    if (!(await verifyRowOwnership(job))) {
      setError(
        `Couldn't confirm this row still belongs to ${job.account} — the schedule may have changed. Tap Refresh and try again.`,
      );
      setSaving(null);
      return;
    }
    // Update the dropdown instantly — don't wait for the sheet round-trip.
    setPicked((p) => ({ ...p, [job.rowId]: status }));
    try {
      const result = await updateJobStatus(
        job.rowId,
        status,
        job.account,
        job.model,
      );
      if (result.result === ROW_NOT_FOUND) {
        setPicked((p) => {
          const next = { ...p };
          delete next[job.rowId];
          return next;
        });
        setError(
          `Couldn't confirm this row still belongs to ${job.account} — the schedule changed. Tap Refresh and try again.`,
        );
        return;
      }
      logActivity(
        job.account,
        `status → ${status}${shouldNotifyStatus(status) ? "" : " (no email)"}`,
        result.notified || result.acked,
      );
    } catch (e) {
      // Offline (or the request otherwise never reached the script) — queue
      // it rather than rolling the pick back. The engineer chose this
      // status; losing that choice on a dropped connection would be worse
      // than a short sync delay.
      enqueue({
        row: job.rowId,
        action: "status",
        time: stampTime(new Date()),
        status,
        engineer,
        notify: shouldNotifyStatus(status) ? 1 : 0,
        account: job.account,
        machine: job.model,
      });
      setQueue(readQueue());
      logActivity(job.account, `status → ${status} (queued)`, false);
      setError(
        e instanceof Error
          ? `${e.message} — saved offline and will sync automatically.`
          : "Saved offline — will sync automatically.",
      );
    } finally {
      setSaving(null);
    }
  }

  async function handleLog(job: DispatchJob, action: "login" | "logout") {
    if (!engineer) return;
    if (saving) return; // double-click guard
    const status = picked[job.rowId];
    if (action === "logout" && !status) {
      setError("Select a status before logging out.");
      return;
    }

    setSaving(job.rowId);
    setError("");
    if (!(await verifyRowOwnership(job))) {
      setError(
        `Couldn't confirm this row still belongs to ${job.account} — the schedule may have changed. Tap Refresh and try again.`,
      );
      setSaving(null);
      return;
    }

    const at = new Date();
    const stamp = stampTime(at);
    const pending = {
      row: job.rowId,
      action,
      time: stamp,
      ...(action === "logout"
        ? { status, date: at.toLocaleDateString("en-US") }
        : {}),
      engineer,
      notify: 1,
      account: job.account,
      machine: job.model,
    } as Omit<QueueItem, "id" | "attempts" | "acked" | "nextAt">;

    // Write the lock BEFORE the fetch so a crash mid-request still resumes.
    if (action === "login") {
      setLocks(
        setLock({
          row: job.rowId,
          engineerId: engineer.id,
          engineerName: engineer.name,
          engineerEmail: engineer.email,
          accountCode: job.account,
          ts: at.getTime(),
        }),
      );
      setLoginTimes((t) => ({ ...t, [job.rowId]: stamp }));
      setLoginAt((t) => ({ ...t, [job.rowId]: at.getTime() }));
    }

    // Show logout time instantly — don't wait for the sheet round-trip.
    if (action === "logout") {
      setLogoutTimes((t) => ({ ...t, [job.rowId]: stamp }));
      const start = loginAt[job.rowId];
      if (start)
        setDuration((d) => ({
          ...d,
          [job.rowId]: formatDuration(at.getTime() - start),
        }));
    }

    inFlight.current.set(job.rowId + action, pending);

    try {
      const result = await logJobTime(
        job.rowId,
        action,
        job.account,
        job.model,
        action === "logout" ? status : undefined,
      );
      inFlight.current.delete(job.rowId + action);

      if (result.result === CONFLICT) {
        setLocks(clearLock(job.rowId));
        setLoginTimes((t) => {
          const next = { ...t };
          delete next[job.rowId];
          return next;
        });
        // Also roll back the optimistic logout time on conflict.
        if (action === "logout") {
          setLogoutTimes((t) => {
            const next = { ...t };
            delete next[job.rowId];
            return next;
          });
        }
        toast.warning("Another engineer is on this job — please refresh.", {
          className: "border-amber-500",
        });
        logActivity(job.account, `${action} rejected`, false);
        return;
      }

      if (result.result === ROW_NOT_FOUND) {
        setLocks(clearLock(job.rowId));
        setLoginTimes((t) => {
          const next = { ...t };
          delete next[job.rowId];
          return next;
        });
        if (action === "logout") {
          setLogoutTimes((t) => {
            const next = { ...t };
            delete next[job.rowId];
            return next;
          });
        }
        setError(
          `Couldn't confirm this row still belongs to ${job.account} — the schedule changed. Tap Refresh and try again.`,
        );
        logActivity(job.account, `${action} rejected`, false);
        return;
      }

      if (action === "login") {
        setLocks(markLockSynced(job.rowId));
      } else {
        // Logout already shown instantly above — just clean up the lock.
        setLocks(clearLock(job.rowId));
        // Remove the completed job from the list after a brief moment
        // so the engineer can see the logout time before it disappears.
        setTimeout(() => {
          setJobs((prev) => prev.filter((j) => j.rowId !== job.rowId));
        }, 2000);
      }
      logActivity(job.account, action, result.notified || result.acked);
    } catch (e) {
      inFlight.current.delete(job.rowId + action);
      // Roll back optimistic logout time if write failed.
      if (action === "logout") {
        setLogoutTimes((t) => {
          const next = { ...t };
          delete next[job.rowId];
          return next;
        });
      }
      enqueue(pending);
      setQueue(readQueue());
      logActivity(job.account, `${action} queued`, false);
      setError(
        e instanceof Error
          ? `${e.message} — saved offline and will sync automatically.`
          : "Update failed — saved offline.",
      );
    } finally {
      setSaving(null);
    }
  }

  function signOut() {
    localStorage.removeItem("EngineerID");
    localStorage.removeItem("EngineerName");
    localStorage.removeItem("engineerEmail");
    navigate({ to: "/" });
  }

  const pendingCount = queue.filter((q) => q.attempts < MAX_ATTEMPTS).length;
  // "Completed" = logged out, regardless of which status was picked — Running
  // Good, Backlog, whatever. The status dropdown is required before log-out,
  // so a logged-out job always has one.
  const completedJobs = jobs.filter((j) => Boolean(logoutTimes[j.rowId]));
  const completedCount = completedJobs.length;

  /**
   * Every job is in exactly one of three states. Both the mobile cards and
   * the desktop table read from this so the spine, chip and dot never drift
   * apart.
   *
   * Nocturne is mono-accent (one hue, no red/green/yellow roles), so state
   * is encoded the way the ServiceHub_Mobile_dc.html prototype encodes its
   * own status tags — by dot FORM and tonal depth, not by color:
   *   not started → the neutral tag, no dot (their own "Log in first" tag
   *                 carries no dot either)
   *   in progress → filled accent dot, breathing (their "on site" indicator)
   *   completed   → the same filled-accent family, static — a deeper ramp
   *                 step than in-progress rather than a different hue,
   *                 since "contrast comes from the tonal ramps, not
   *                 saturation" is the system's own rule.
   */
  function jobState(rowId: string) {
    const loggedIn = Boolean(loginTimes[rowId]) || Boolean(locks[rowId]);
    const loggedOut = Boolean(logoutTimes[rowId]);
    if (loggedOut)
      return {
        key: "done" as const,
        label: "Completed",
        spine: "var(--color-accent-700)",
        chip: "bg-accent-800 text-accent-100",
        dot: "bg-accent-300",
      };
    if (loggedIn)
      return {
        key: "onsite" as const,
        label: "In progress",
        spine: "var(--color-accent-500)",
        chip: "bg-accent-800 text-accent-100",
        dot: "live-dot bg-accent-300",
      };
    return {
      key: "waiting" as const,
      label: "Not started",
      spine: "var(--color-neutral-700)",
      chip: "bg-neutral-800 text-neutral-300",
      dot: null,
    };
  }

  return (
    <main className="min-h-screen bg-background px-4 py-10">
      <div className="mx-auto w-full max-w-6xl">
        <header className="pb-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <h1 className="text-3xl leading-none text-foreground sm:text-4xl">
                Daily dispatch
              </h1>
              <p className="mt-2 text-sm text-neutral-400">
                {engineer ? (
                  <>
                    <span className="font-medium text-foreground">
                      {engineer.name || "Engineer"}
                    </span>
                    <span className="mx-1.5 text-neutral-700">·</span>
                    <span className="tabular-nums">ID {engineer.id}</span>
                  </>
                ) : (
                  "Loading…"
                )}
              </p>
            </div>

            <div className="flex flex-col items-end gap-2">
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  onClick={() => engineer && load(engineer.id, engineer.name)}
                  disabled={loading}
                  size="sm"
                >
                  {loading ? "Refreshing…" : "Refresh"}
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={signOut}
                  aria-label="Sign out"
                  className="h-9 w-9"
                >
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 256 256"
                    fill="currentColor"
                  >
                    <path d="M124,216a12,12,0,0,1-12,12H48a20,20,0,0,1-20-20V48A20,20,0,0,1,48,28h64a12,12,0,0,1,0,24H52V212h60A12,12,0,0,1,124,216Zm113.66-96-40-40a12,12,0,0,0-17,17L204.7,116H112a12,12,0,0,0,0,24h92.7l-24.05,19.51a12,12,0,1,0,17,17l40-40A12,12,0,0,0,237.66,120Z" />
                  </svg>
                </Button>
              </div>
              {now && (
                <p className="text-xs text-neutral-500">
                  {now.toLocaleDateString("en-US", {
                    month: "long",
                    day: "numeric",
                  })}
                  <span className="mx-1.5 text-neutral-700">·</span>
                  <span className="tabular-nums">
                    {now
                      .toLocaleTimeString("en-US", {
                        hour: "numeric",
                        minute: "2-digit",
                        second: "2-digit",
                        hour12: true,
                      })
                      .toLowerCase()}
                  </span>
                </p>
              )}
              <button
                type="button"
                onClick={() => void drain()}
                className="flex items-center gap-1.5 text-xs text-neutral-500 transition-colors hover:text-neutral-300"
              >
                <span
                  className={`h-1.5 w-1.5 rounded-full ${offline ? "bg-neutral-500" : "bg-accent-300"}`}
                />
                {offline ? "No connection — tap to retry" : "Connected"}
              </button>
            </div>
          </div>

          {/* Duty bar — the day at a glance, before any scrolling. */}
          <dl className="mt-5 grid grid-cols-2 rounded-xl border border-neutral-700 bg-neutral-800">
            <div className="px-4 py-3.5">
              <dt className="eyebrow">Assigned</dt>
              <dd className="mt-1.5 text-3xl leading-none font-medium tabular-nums text-foreground">
                {jobs.length}
              </dd>
            </div>
            <button
              type="button"
              onClick={() => setCompletedOpen(true)}
              aria-haspopup="dialog"
              className="rounded-r-xl border-l border-neutral-700 px-4 py-3.5 text-left transition-colors hover:bg-neutral-700/50"
            >
              <dt className="eyebrow flex items-center gap-1">
                Completed
                <span aria-hidden="true" className="text-accent-300">
                  ›
                </span>
              </dt>
              <dd className="mt-1.5 text-3xl leading-none font-medium tabular-nums text-accent-300">
                {completedCount}
              </dd>
            </button>
          </dl>
        </header>

        <Dialog open={completedOpen} onOpenChange={setCompletedOpen}>
          <DialogContent className="max-h-[80vh] max-w-lg overflow-y-auto rounded-xl border-neutral-700 bg-card">
            <DialogHeader>
              <DialogTitle className="text-xl font-medium">
                Completed today
              </DialogTitle>
              <DialogDescription>
                Every job you've logged out of today, with its status and time
                on site. This clears automatically at midnight — the sheet keeps
                the permanent record.
              </DialogDescription>
            </DialogHeader>
            {completedJobs.length === 0 ? (
              <p className="rounded-lg border border-neutral-700 bg-neutral-800 px-4 py-8 text-center text-sm text-neutral-500">
                No completed jobs yet today.
              </p>
            ) : (
              <ul className="space-y-3">
                {completedJobs.map((job) => (
                  <li
                    key={job.rowId}
                    className="spine rounded-xl border border-neutral-700 bg-neutral-800 px-4 py-3"
                    style={
                      {
                        "--spine-color": "var(--color-accent-700)",
                      } as React.CSSProperties
                    }
                  >
                    <p className="font-medium text-foreground">{job.account}</p>
                    <p className="text-xs text-neutral-500">{job.model}</p>
                    <p className="mt-2 text-sm text-foreground">
                      {picked[job.rowId] ?? job.status ?? "—"}
                    </p>
                    <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 border-t border-neutral-700 pt-2 text-xs text-neutral-500">
                      <span>
                        In{" "}
                        <span className="tabular-nums text-neutral-300">
                          {loginTimes[job.rowId] ?? "—"}
                        </span>
                      </span>
                      <span>
                        Out{" "}
                        <span className="tabular-nums text-neutral-300">
                          {logoutTimes[job.rowId] ?? "—"}
                        </span>
                      </span>
                      {duration[job.rowId] && (
                        <span>
                          Duration{" "}
                          <span className="font-medium tabular-nums text-neutral-300">
                            {duration[job.rowId]}
                          </span>
                        </span>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </DialogContent>
        </Dialog>

        {pendingCount > 0 && !stalled && (
          <p className="mt-4 border border-accent bg-accent/20 px-4 py-3 text-sm text-accent-foreground">
            {pendingCount} pending {pendingCount === 1 ? "event" : "events"}{" "}
            will sync when the network is back.
          </p>
        )}

        {stalled && (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            <span>
              Some events could not be sent after {MAX_ATTEMPTS} attempts.
            </span>
            <span className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setQueue(resetQueueBackoff());
                  void drain();
                }}
              >
                Retry now
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  const kept = readQueue().filter(
                    (q) => q.attempts < MAX_ATTEMPTS,
                  );
                  writeQueue(kept);
                  setQueue(kept);
                  toast.info(
                    "Discarded — please notify the dispatcher manually.",
                  );
                }}
              >
                Discard (notify dispatcher)
              </Button>
            </span>
          </div>
        )}

        {error && (
          <p className="mt-6 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {error}
          </p>
        )}

        <section className="mt-6 border border-border bg-card p-4">
          <h2 className="text-sm font-medium text-foreground">
            Recent activity
          </h2>
          {activity.length === 0 ? (
            <p className="mt-2 text-xs text-muted-foreground">
              Notifications you trigger will appear here.
            </p>
          ) : (
            <ul className="mt-3 space-y-2">
              {activity.map((item) => (
                <li key={item.id} className="flex items-center gap-3 text-xs">
                  <span
                    className={
                      item.ok
                        ? "inline-block h-2 w-2 shrink-0 rounded-full bg-green-500"
                        : "inline-block h-2 w-2 shrink-0 rounded-full bg-red-500"
                    }
                    aria-label={item.ok ? "Notified" : "Not confirmed"}
                  />
                  <span className="tabular-nums text-muted-foreground">
                    {item.time}
                  </span>
                  <span className="font-medium text-foreground">
                    {item.engineer}
                  </span>
                  <span className="text-muted-foreground">{item.account}</span>
                  <span className="text-muted-foreground">→ {item.event}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="mt-6">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="eyebrow text-muted-foreground">Assigned jobs</h2>
            <span className="eyebrow text-muted-foreground tabular-nums">
              {jobs.length} total
            </span>
          </div>

          {/* ---------- Mobile: one tap-target card per job ---------- */}
          <div className="mt-3 space-y-3 md:hidden">
            {loading && (
              <p className="border border-border bg-card px-4 py-10 text-center text-sm text-muted-foreground">
                Loading jobs…
              </p>
            )}
            {!loading && jobs.length === 0 && (
              <p className="border border-border bg-card px-4 py-10 text-center text-sm text-muted-foreground">
                No jobs assigned today.
              </p>
            )}
            {!loading &&
              jobs.map((job) => {
                const lock = locks[job.rowId];
                const loggedIn =
                  Boolean(loginTimes[job.rowId]) || Boolean(lock);
                const loggedOut = Boolean(logoutTimes[job.rowId]);
                const unconfirmed = Boolean(lock && !lock.syncedAt);
                const busy = saving === job.rowId;
                const state = jobState(job.rowId);
                // The job you're currently working opens by default; the rest
                // stay collapsed so the day fits on one screen.
                const isOpen = expanded[job.rowId] ?? (loggedIn && !loggedOut);
                return (
                  <article
                    key={job.rowId}
                    className="spine overflow-hidden rounded-xl border border-neutral-700 bg-neutral-800"
                    style={
                      { "--spine-color": state.spine } as React.CSSProperties
                    }
                  >
                    <button
                      type="button"
                      aria-expanded={isOpen}
                      aria-controls={`job-details-${job.rowId}`}
                      onClick={() =>
                        setExpanded((e) => ({
                          ...e,
                          [job.rowId]: !e[job.rowId],
                        }))
                      }
                      className="flex w-full items-start justify-between gap-3 border-b border-neutral-700 px-4 py-3 pl-5 text-left transition-colors hover:bg-neutral-700/40"
                    >
                      <div className="min-w-0">
                        <h3 className="truncate text-lg leading-tight text-foreground">
                          {job.account}
                        </h3>
                        <p className="mt-0.5 truncate text-xs text-muted-foreground">
                          {job.model}
                        </p>
                      </div>
                      <span className="flex shrink-0 items-center gap-2">
                        <span
                          className={`eyebrow flex items-center gap-1.5 rounded-full px-2 py-1.5 ${state.chip}`}
                        >
                          {state.dot && (
                            <span
                              className={`inline-block h-1.5 w-1.5 rounded-full ${state.dot}`}
                            />
                          )}
                          {state.label}
                        </span>
                        <span
                          aria-hidden="true"
                          className={`text-muted-foreground transition-transform ${isOpen ? "rotate-180" : ""}`}
                        >
                          ▾
                        </span>
                      </span>
                    </button>

                    {isOpen && (
                      <dl
                        id={`job-details-${job.rowId}`}
                        className="space-y-2.5 px-4 py-3 pl-5 text-sm"
                      >
                        <div>
                          <dt className="eyebrow text-muted-foreground">
                            Purpose
                          </dt>
                          <dd className="mt-1 text-foreground">
                            {job.purpose || "—"}
                          </dd>
                        </div>
                        {job.remarks && (
                          <div>
                            <dt className="eyebrow text-muted-foreground">
                              Remarks / contact / address
                            </dt>
                            <dd className="mt-1 whitespace-pre-wrap text-muted-foreground">
                              {linkifyPhones(job.remarks)}
                            </dd>
                          </div>
                        )}
                        {(loggedIn || loggedOut) && (
                          <div className="flex gap-6 border-t border-neutral-700 pt-2.5">
                            <div>
                              <dt className="eyebrow text-muted-foreground">
                                In
                              </dt>
                              <dd className="mt-1 tabular-nums text-foreground">
                                {loginTimes[job.rowId] ?? "—"}
                              </dd>
                            </div>
                            <div>
                              <dt className="eyebrow text-muted-foreground">
                                Out
                              </dt>
                              <dd className="mt-1 tabular-nums text-foreground">
                                {logoutTimes[job.rowId] ?? "—"}
                              </dd>
                            </div>
                            {duration[job.rowId] && (
                              <div>
                                <dt className="eyebrow text-muted-foreground">
                                  Duration
                                </dt>
                                <dd className="mt-1 font-medium tabular-nums text-foreground">
                                  {duration[job.rowId]}
                                </dd>
                              </div>
                            )}
                          </div>
                        )}
                      </dl>
                    )}

                    <div className="space-y-2 border-t border-neutral-700 bg-neutral-900/40 px-4 py-3 pl-5">
                      {unconfirmed && (
                        <p className="eyebrow rounded-md bg-destructive/15 px-2 py-1.5 text-destructive">
                          Resume · unsynced
                        </p>
                      )}
                      <Select
                        value={
                          picked[job.rowId] ??
                          (STATUS_OPTIONS.includes(job.status as StatusOption)
                            ? job.status
                            : "")
                        }
                        disabled={!loggedIn || unconfirmed || loggedOut || busy}
                        onValueChange={(v) =>
                          handleStatus(job, v as StatusOption)
                        }
                      >
                        <SelectTrigger
                          className="h-11 w-full"
                          aria-label={`Status for ${job.account}`}
                        >
                          <SelectValue
                            placeholder={
                              !loggedIn
                                ? "Log in first"
                                : unconfirmed
                                  ? "Confirming…"
                                  : busy
                                    ? "Saving…"
                                    : "Select status"
                            }
                          />
                        </SelectTrigger>
                        <SelectContent>
                          {STATUS_OPTIONS.map((s) => (
                            <SelectItem key={s} value={s}>
                              {s}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>

                      {!loggedIn && (
                        <Button
                          className="h-12 w-full text-base font-medium"
                          disabled={
                            busy ||
                            (activeJob !== null && activeJob !== job.rowId)
                          }
                          onClick={() => handleLog(job, "login")}
                        >
                          {busy ? "Saving…" : "Log in"}
                        </Button>
                      )}
                      {loggedIn && !loggedOut && (
                        <Button
                          variant="outline"
                          className="h-12 w-full text-base font-medium"
                          disabled={!picked[job.rowId] || busy}
                          onClick={() => handleLog(job, "logout")}
                        >
                          {busy
                            ? "Saving…"
                            : unconfirmed
                              ? "Resume / Log out"
                              : "Log out"}
                        </Button>
                      )}
                      {loggedOut && (
                        <p className="py-1 text-center text-sm text-muted-foreground">
                          Job closed. Dispatcher notified.
                        </p>
                      )}
                    </div>
                  </article>
                );
              })}
          </div>

          {/* ---------- Desktop: full table ---------- */}
          <div className="mt-3 hidden overflow-hidden rounded-xl border border-neutral-700 bg-neutral-800 md:block">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[900px] text-left text-sm">
                <thead className="border-b border-neutral-700 bg-neutral-900/40">
                  <tr className="eyebrow">
                    <th className="px-4 py-3 pl-5">Account</th>
                    <th className="px-4 py-3">Machine model</th>
                    <th className="px-4 py-3">Purpose</th>
                    <th className="px-4 py-3">
                      Remarks / Contact person / Contact no / Address
                    </th>
                    <th className="px-4 py-3">Status after service</th>
                    <th className="px-4 py-3">Log in</th>
                    <th className="px-4 py-3">Log out</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-700">
                  {loading && (
                    <tr>
                      <td
                        colSpan={7}
                        className="px-4 py-10 text-center text-muted-foreground"
                      >
                        Loading jobs…
                      </td>
                    </tr>
                  )}
                  {!loading && jobs.length === 0 && (
                    <tr>
                      <td
                        colSpan={7}
                        className="px-4 py-10 text-center text-muted-foreground"
                      >
                        No jobs assigned today.
                      </td>
                    </tr>
                  )}
                  {!loading &&
                    jobs.map((job) => {
                      const lock = locks[job.rowId];
                      const loggedIn =
                        Boolean(loginTimes[job.rowId]) || Boolean(lock);
                      const loggedOut = Boolean(logoutTimes[job.rowId]);
                      const unconfirmed = Boolean(lock && !lock.syncedAt);
                      const busy = saving === job.rowId;
                      const state = jobState(job.rowId);
                      return (
                        <tr
                          key={job.rowId}
                          className="align-top transition-colors hover:bg-muted/40"
                        >
                          <td
                            className="spine px-4 py-3 pl-5"
                            style={
                              {
                                "--spine-color": state.spine,
                              } as React.CSSProperties
                            }
                          >
                            <span className="font-medium text-foreground">
                              {job.account}
                            </span>
                            <span
                              className={`eyebrow mt-1.5 flex w-fit items-center gap-1.5 rounded-full px-2 py-1 ${state.chip}`}
                            >
                              {state.dot && (
                                <span
                                  className={`inline-block h-1.5 w-1.5 rounded-full ${state.dot}`}
                                />
                              )}
                              {state.label}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-muted-foreground">
                            {job.model}
                          </td>
                          <td className="px-4 py-3 text-muted-foreground">
                            {job.purpose}
                          </td>
                          <td className="max-w-sm px-4 py-3 whitespace-pre-wrap text-muted-foreground">
                            {linkifyPhones(job.remarks)}
                          </td>
                          <td className="px-4 py-3">
                            <Select
                              value={
                                picked[job.rowId] ??
                                (STATUS_OPTIONS.includes(
                                  job.status as StatusOption,
                                )
                                  ? job.status
                                  : "")
                              }
                              disabled={
                                !loggedIn || unconfirmed || loggedOut || busy
                              }
                              onValueChange={(v) =>
                                handleStatus(job, v as StatusOption)
                              }
                            >
                              <SelectTrigger
                                className="w-64"
                                aria-label={`Status for ${job.account}`}
                              >
                                <SelectValue
                                  placeholder={
                                    !loggedIn
                                      ? "Log in first"
                                      : unconfirmed
                                        ? "Confirming…"
                                        : busy
                                          ? "Saving…"
                                          : "Select status"
                                  }
                                />
                              </SelectTrigger>
                              <SelectContent>
                                {STATUS_OPTIONS.map((s) => (
                                  <SelectItem key={s} value={s}>
                                    {s}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            <p className="mt-1 max-w-64 text-[11px] leading-snug text-muted-foreground">
                              Engineers and the dispatcher email will be
                              notified on completion.
                            </p>
                          </td>
                          <td className="px-4 py-3">
                            {loggedIn ? (
                              <span className="flex flex-col gap-1">
                                <span className="tabular-nums text-foreground">
                                  {loginTimes[job.rowId] ?? "—"}
                                </span>
                                {unconfirmed && (
                                  <span className="eyebrow w-fit rounded-md bg-destructive/15 px-2 py-1 text-destructive">
                                    Resume · unsynced
                                  </span>
                                )}
                              </span>
                            ) : (
                              <Button
                                size="sm"
                                disabled={
                                  busy ||
                                  (activeJob !== null &&
                                    activeJob !== job.rowId)
                                }
                                onClick={() => handleLog(job, "login")}
                              >
                                {busy ? "Saving…" : "Log in"}
                              </Button>
                            )}
                          </td>
                          <td className="px-4 py-3">
                            {loggedOut ? (
                              <span className="flex flex-col gap-1 text-xs">
                                <span className="tabular-nums text-foreground">
                                  {logoutTimes[job.rowId]}
                                </span>
                                {duration[job.rowId] && (
                                  <span className="text-muted-foreground">
                                    {duration[job.rowId]} total
                                  </span>
                                )}
                              </span>
                            ) : (
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={
                                  !loggedIn || !picked[job.rowId] || busy
                                }
                                onClick={() => handleLog(job, "logout")}
                              >
                                {busy
                                  ? "Saving…"
                                  : unconfirmed
                                    ? "Resume / Log out"
                                    : "Log out"}
                              </Button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
