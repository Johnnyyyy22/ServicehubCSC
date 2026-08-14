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
  CONFLICT,
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
        content: "View assigned service jobs and update machine status after service.",
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
  const [loginAt, setLoginAt] = useState<Record<string, number>>({});
  const [duration, setDuration] = useState<Record<string, string>>({});
  const [picked, setPicked] = useState<Record<string, StatusOption>>({});
  const [locks, setLocks] = useState<LockMap>({});
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [offline, setOffline] = useState(false);
  const [activity, setActivity] = useState<ActivityEvent[]>([]);
  const inFlight = useRef<Map<string, Omit<QueueItem, "id" | "attempts" | "acked" | "nextAt">>>(
    new Map(),
  );
  const forced = useRef<Set<string>>(new Set());

  const lockedRow = Object.keys(locks)[0] ?? null;
  const activeJob = lockedRow ?? (Object.keys(loginTimes).find((r) => !logoutTimes[r]) ?? null);
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
      logActivity(item.account ?? "", `${item.action} synced`, result.notified || result.ok);
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
      const mine = all.filter(
        (j) =>
          (j.engineerId.trim().toLowerCase() === idKey ||
            j.engineer.trim().toLowerCase() === nameKey) &&
          (j.account || j.model || j.purpose),
      );
      setJobs(mine);
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
          setLoginTimes((t) => ({ ...t, [row]: job?.logIn || stampTime(new Date(lock.ts)) }));
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
          const result = await logJobTime(row, "login", undefined, true);
          if (result.result === CONFLICT) {
            clearLock(row);
            toast.warning("Another engineer is on this job — please refresh.", {
              className: "border-amber-500",
            });
          } else {
            markLockSynced(row);
            logActivity(lock.accountCode, "login recovered", result.notified || result.acked);
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

  /* ----------------------------- actions ----------------------------- */
  async function handleStatus(job: DispatchJob, status: StatusOption) {
    if (!engineer) return;
    setSaving(job.rowId);
    setError("");
    // Update the dropdown instantly — don't wait for the sheet round-trip.
    setPicked((p) => ({ ...p, [job.rowId]: status }));
    try {
      const result = await updateJobStatus(job.rowId, status);
      logActivity(
        job.account,
        `status → ${status}${shouldNotifyStatus(status) ? "" : " (no email)"}`,
        result.notified || result.acked,
      );
    } catch (e) {
      // Roll back the optimistic update if the write failed.
      setPicked((p) => {
        const next = { ...p };
        delete next[job.rowId];
        return next;
      });
      setError(e instanceof Error ? e.message : "Update failed.");
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

    const at = new Date();
    const stamp = stampTime(at);
    const pending = {
      row: job.rowId,
      action,
      time: stamp,
      ...(action === "logout" ? { status, date: at.toLocaleDateString("en-US") } : {}),
      engineer,
      notify: 1,
      account: job.account,
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
      if (start) setDuration((d) => ({ ...d, [job.rowId]: formatDuration(at.getTime() - start) }));
    }

    setSaving(job.rowId);
    setError("");
    inFlight.current.set(job.rowId + action, pending);

    try {
      const result = await logJobTime(job.rowId, action, action === "logout" ? status : undefined);
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

  return (
    <main className="min-h-screen bg-background px-4 py-10">
      <div className="mx-auto w-full max-w-6xl">
        <header className="flex flex-wrap items-end justify-between gap-4 border-b border-border pb-6">
          <div>
            <div className="flex flex-wrap items-baseline gap-3">
              <h1 className="text-3xl font-semibold tracking-tight text-foreground">
                Daily dispatch
              </h1>
              <span className="text-sm font-medium text-muted-foreground">
                {now
                  ? `Today is, ${now.toLocaleDateString("en-US", {
                      month: "long",
                      day: "numeric",
                      year: "numeric",
                    })}, ${now
                      .toLocaleTimeString("en-US", {
                        hour: "numeric",
                        minute: "2-digit",
                        second: "2-digit",
                        hour12: true,
                      })
                      .toLowerCase()}`
                  : ""}
              </span>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {engineer ? `${engineer.name || "Engineer"} · ID ${engineer.id}` : "Loading…"}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {offline && (
              <span className="border border-accent bg-accent/40 px-3 py-1 text-xs font-medium text-accent-foreground">
                Offline
              </span>
            )}
            <Button variant="outline" onClick={() => engineer && load(engineer.id, engineer.name)} disabled={loading}>
              Refresh
            </Button>
            <Button
              variant="outline"
              onClick={signOut}
              className="border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/20 hover:text-destructive"
            >
              Sign out
            </Button>
          </div>
        </header>

        {pendingCount > 0 && !stalled && (
          <p className="mt-4 border border-accent bg-accent/20 px-4 py-3 text-sm text-accent-foreground">
            {pendingCount} pending {pendingCount === 1 ? "event" : "events"} will sync when the
            network is back.
          </p>
        )}

        {stalled && (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            <span>Some events could not be sent after {MAX_ATTEMPTS} attempts.</span>
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
                  const kept = readQueue().filter((q) => q.attempts < MAX_ATTEMPTS);
                  writeQueue(kept);
                  setQueue(kept);
                  toast.info("Discarded — please notify the dispatcher manually.");
                }}
              >
                Discard (notify dispatcher)
              </Button>
            </span>
          </div>
        )}

        {error && (
          <p className="mt-6 border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {error}
          </p>
        )}

        <section className="mt-6 border border-border bg-card p-4">
          <h2 className="text-sm font-semibold text-foreground">Recent activity</h2>
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
                  <span className="tabular-nums text-muted-foreground">{item.time}</span>
                  <span className="font-medium text-foreground">{item.engineer}</span>
                  <span className="text-muted-foreground">{item.account}</span>
                  <span className="text-muted-foreground">→ {item.event}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <div className="mt-6 overflow-x-auto border border-border bg-card">
          <table className="w-full min-w-[900px] text-left text-sm">
            <thead className="bg-muted/60 text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-3 font-medium">Account</th>
                <th className="px-4 py-3 font-medium">Machine model</th>
                <th className="px-4 py-3 font-medium">Purpose</th>
                <th className="px-4 py-3 font-medium">
                  Remarks / Contact person / Contact no / Address
                </th>
                <th className="px-4 py-3 font-medium">Status after service</th>
                <th className="px-4 py-3 font-medium">Log in</th>
                <th className="px-4 py-3 font-medium">Log out</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {loading && (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-muted-foreground">
                    Loading jobs…
                  </td>
                </tr>
              )}
              {!loading && jobs.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-muted-foreground">
                    No jobs assigned.
                  </td>
                </tr>
              )}
              {!loading &&
                jobs.map((job) => {
                  const lock = locks[job.rowId];
                  const loggedIn = Boolean(loginTimes[job.rowId]) || Boolean(lock);
                  const loggedOut = Boolean(logoutTimes[job.rowId]);
                  const unconfirmed = Boolean(lock && !lock.syncedAt);
                  const busy = saving === job.rowId;
                  return (
                    <tr key={job.rowId} className="align-top">
                      <td className="px-4 py-3 font-medium text-foreground">{job.account}</td>
                      <td className="px-4 py-3 text-muted-foreground">{job.model}</td>
                      <td className="px-4 py-3 text-muted-foreground">{job.purpose}</td>
                      <td className="max-w-sm px-4 py-3 whitespace-pre-wrap text-muted-foreground">
                        {job.remarks}
                      </td>
                      <td className="px-4 py-3">
                        <Select
                          value={
                            picked[job.rowId] ??
                            (STATUS_OPTIONS.includes(job.status as StatusOption) ? job.status : "")
                          }
                          disabled={!loggedIn || unconfirmed || loggedOut || busy}
                          onValueChange={(v) => handleStatus(job, v as StatusOption)}
                        >
                          <SelectTrigger className="w-64" aria-label={`Status for ${job.account}`}>
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
                          Engineers and the dispatcher email will be notified on completion.
                        </p>
                      </td>
                      <td className="px-4 py-3">
                        {loggedIn ? (
                          <span className="flex flex-col gap-1">
                            <span className="text-xs text-muted-foreground">
                              {loginTimes[job.rowId] ?? "—"}
                            </span>
                            {unconfirmed && (
                              <span className="w-fit border border-accent bg-accent/30 px-2 py-0.5 text-[11px] font-medium text-accent-foreground">
                                Resume · unsynced
                              </span>
                            )}
                          </span>
                        ) : (
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={busy || (activeJob !== null && activeJob !== job.rowId)}
                            onClick={() => handleLog(job, "login")}
                          >
                            {busy ? "Saving…" : "Log in"}
                          </Button>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {loggedOut ? (
                          <span className="flex flex-col gap-1 text-xs text-muted-foreground">
                            <span>{logoutTimes[job.rowId]}</span>
                            {duration[job.rowId] && <span>{duration[job.rowId]} on site</span>}
                          </span>
                        ) : (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={!loggedIn || !picked[job.rowId] || busy}
                            onClick={() => handleLog(job, "logout")}
                          >
                            {busy ? "Saving…" : unconfirmed ? "Resume / Log out" : "Log out"}
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
    </main>
  );
}
