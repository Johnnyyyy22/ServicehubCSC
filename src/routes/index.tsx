import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { createPrimeableSound } from "@/lib/sound";
import { fetchLoginRows, withTimeout } from "@/lib/dispatch-api";
import {
  cacheOfflineCredential,
  verifyOfflineCredential,
} from "@/lib/dispatch-store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "ServiceHub" },
      {
        name: "description",
        content:
          "When others rest, We rise! — Service Hub, the home of unstoppable service.",
      },
      { property: "og:title", content: "ServiceHub" },
      {
        property: "og:description",
        content:
          "When others rest, We rise! — Service Hub, the home of unstoppable service.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: LoginPage,
});

function LoginPage() {
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  // Played once sign-in actually succeeds. Primed synchronously below,
  // before any await, so the browser's user-gesture requirement for
  // audio playback is satisfied — see src/lib/sound.ts for why.
  const loginChime = useRef(createPrimeableSound("/login-success.mp3")).current;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    loginChime.prime();
    const u = username.trim();
    const p = password.trim();

    // Skip straight to the offline path if the browser already knows
    // there's no connection — no point waiting on a fetch that can't
    // succeed. If the browser THINKS it's online but actually isn't (a
    // common lie on flaky mobile signal), the timeout below catches that.
    const knownOffline =
      typeof navigator !== "undefined" && navigator.onLine === false;

    if (!knownOffline) {
      try {
        const rows = await withTimeout(fetchLoginRows(), 15_000);
        const uKey = u.toLowerCase();
        const pKey = p.toLowerCase();
        const match = rows.find(
          (r) =>
            String(r[2]).trim().toLowerCase() === uKey &&
            String(r[3]).trim().toLowerCase() === pKey,
        );
        if (!match) {
          setError("Invalid login");
          setLoading(false);
          return;
        }
        const engineerId = String(match[0]);
        const engineerName = String(match[1] ?? "");
        // Column E of the Users tab holds the engineer's email; fall back to
        // any cell in the row that looks like an address so notifications
        // still work.
        const emailCell =
          match.slice(4).find((c) => String(c ?? "").includes("@")) ??
          match.find((c) => String(c ?? "").includes("@")) ??
          "";
        const engineerEmail = String(emailCell).trim();

        localStorage.setItem("EngineerID", engineerId);
        localStorage.setItem("EngineerName", engineerName);
        localStorage.setItem("engineerEmail", engineerEmail);
        // So this device can sign this engineer in again with zero signal.
        void cacheOfflineCredential(
          u,
          p,
          engineerId,
          engineerName,
          engineerEmail,
        );
        loginChime.play();
        navigate({ to: "/dispatch" });
        return;
      } catch {
        // Fall through to the offline path below — could be a dead
        // connection, a timeout, or the script being unreachable.
      }
    }

    // Offline path: check against whatever this device last verified
    // online for this username.
    const cached = await verifyOfflineCredential(u, p);
    if (cached) {
      localStorage.setItem("EngineerID", cached.engineerId);
      localStorage.setItem("EngineerName", cached.engineerName);
      localStorage.setItem("engineerEmail", cached.engineerEmail);
      loginChime.play();
      toast.info("Signed in offline — this will sync once you're back online.");
      navigate({ to: "/dispatch" });
      setLoading(false);
      return;
    }

    setError(
      knownOffline || !navigator.onLine
        ? "No connection, and this device hasn't signed you in before — connect once, then try again."
        : "Invalid login",
    );
    setLoading(false);
  }

  return (
    <main className="hero-glow flex min-h-screen items-center justify-center px-6 py-12">
      <div className="flex w-full max-w-sm flex-col gap-7">
        <h1 className="sr-only">Service Hub</h1>
        <div className="flex flex-col items-center gap-2.5">
          <img
            src="/logo.png"
            alt="Service Hub logo"
            className="h-14 w-auto mix-blend-lighten"
          />
          <p className="text-center text-[11.5px] leading-relaxed text-neutral-500">
            When others rest, we rise.
            <br />
            Service Hub — the home of unstoppable service.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="username" className="text-xs text-neutral-400">
              Username
            </Label>
            <Input
              className="h-11"
              id="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="password" className="text-xs text-neutral-400">
              Password
            </Label>
            <Input
              className="h-11"
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </div>
          {error && (
            <p className="text-[13px] text-accent-300">
              {error} — check your username and password, then try again.
            </p>
          )}
          <Button
            type="submit"
            className="mt-1 h-11 w-full text-[15px]"
            disabled={loading}
          >
            {loading ? "Checking…" : "Log in"}
            <svg
              width="14"
              height="14"
              viewBox="0 0 256 256"
              fill="currentColor"
            >
              <path d="M221.66,133.66l-72,72a8,8,0,0,1-11.32-11.32L196.69,136H40a8,8,0,0,1,0-16H196.69L138.34,61.66a8,8,0,0,1,11.32-11.32l72,72A8,8,0,0,1,221.66,133.66Z" />
            </svg>
          </Button>
        </form>

        <p className="text-center text-[11px] text-neutral-600">
          Created by Christer John Parco
        </p>
      </div>
    </main>
  );
}
