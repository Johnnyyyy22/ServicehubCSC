import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { fetchLoginRows } from "@/lib/dispatch-api";
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

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const rows = await fetchLoginRows();
      const u = username.trim().toLowerCase();
      const p = password.trim().toLowerCase();
      const match = rows.find(
        (r) =>
          String(r[2]).trim().toLowerCase() === u &&
          String(r[3]).trim().toLowerCase() === p,
      );
      if (!match) {
        setError("Invalid login");
        return;
      }
      localStorage.setItem("EngineerID", String(match[0]));
      localStorage.setItem("EngineerName", String(match[1] ?? ""));
      // Column E of the Users tab holds the engineer's email; fall back to any
      // cell in the row that looks like an address so notifications still work.
      const emailCell =
        match.slice(4).find((c) => String(c ?? "").includes("@")) ??
        match.find((c) => String(c ?? "").includes("@")) ??
        "";
      localStorage.setItem("engineerEmail", String(emailCell).trim());
      navigate({ to: "/dispatch" });
    } catch {
      setError("Invalid login");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm border-2 border-foreground bg-card shadow-lg">
        <div className="h-2 w-full bg-hivis" />
        <div className="p-8">
          <h1 className="sr-only">Service Hub</h1>
          <img
            src="/logo.png"
            alt="Service Hub logo"
            className="mx-auto h-12 w-auto"
          />
          <p className="eyebrow mt-5 text-center text-primary">
            Field dispatch · Engineer sign in
          </p>
          <p className="mt-4 border-t border-border pt-4 text-center text-sm leading-relaxed text-muted-foreground">
            When others rest, We rise! — Service Hub, the home of unstoppable
            service.
          </p>
          <form onSubmit={handleSubmit} className="mt-8 space-y-4">
            <div className="space-y-2">
              <Label htmlFor="username">Username</Label>
              <Input
                className="h-11"
                id="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
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
              <p className="border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive">
                {error} — check your username and password, then try again.
              </p>
            )}
            <Button
              type="submit"
              className="h-12 w-full text-base font-semibold"
              disabled={loading}
            >
              {loading ? "Checking…" : "Log in"}
            </Button>
          </form>
        </div>
        <p className="border-t border-border px-8 py-3 text-center text-[11px] text-muted-foreground">
          Created by Christer John Parco
        </p>
      </div>
    </main>
  );
}
