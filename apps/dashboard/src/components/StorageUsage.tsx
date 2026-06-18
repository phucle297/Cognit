/**
 * apps/dashboard/src/components/StorageUsage.tsx — live storage usage.
 *
 * FSD layer: components. Fetches /sessions to count sessions, then
 * /events?session_id=<id> per session and sums events. Artifacts are
 * intentionally not counted in v0.1 — there is no artifact endpoint
 * yet, so we render "(v0.2: artifact index)" as a placeholder.
 */
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { apiFetch } from "@/lib/api-client";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/shared/ui/card";

type Session = {
  id: string;
  project_id: string;
  goal?: string;
  status: string;
  created_at: string;
};

type UsageState = {
  status: "idle" | "loading" | "ready" | "error";
  sessions: number;
  events: number;
  error?: string;
};

export const StorageUsage = (): JSX.Element => {
  const [state, setState] = useState<UsageState>({
    status: "idle",
    sessions: 0,
    events: 0,
  });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading", sessions: 0, events: 0 });

    void (async () => {
      try {
        const { sessions } = await apiFetch<{ sessions: Session[] }>("/api/sessions");
        const counts = await Promise.all(
          sessions.map((s) =>
            apiFetch<{ events: unknown[] }>(
              `/api/events?session_id=${encodeURIComponent(s.id)}`,
            ).then((r) => r.events.length),
          ),
        );
        const totalEvents = counts.reduce((a, b) => a + b, 0);
        if (!cancelled) {
          setState({
            status: "ready",
            sessions: sessions.length,
            events: totalEvents,
          });
        }
      } catch (err) {
        if (!cancelled) {
          setState({
            status: "error",
            sessions: 0,
            events: 0,
            error: err instanceof Error ? err.message : "unknown error",
          });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>Storage usage</CardTitle>
          <span className="text-xs text-muted-foreground">v0.1 preview</span>
        </div>
        <CardDescription>
          Counts derived from /sessions and /events. Artifact index lands in v0.2.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {state.status === "loading" || state.status === "idle" ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : state.status === "error" ? (
          <p className="text-sm text-destructive">
            Failed to load storage usage: {state.error ?? "unknown error"}
          </p>
        ) : (
          <dl className="grid grid-cols-[12rem_1fr] gap-y-2 text-sm">
            <dt className="text-muted-foreground">Sessions</dt>
            <dd className="font-mono" data-testid="sessions-count">
              {state.sessions}
            </dd>
            <dt className="text-muted-foreground">Events</dt>
            <dd className="font-mono" data-testid="events-count">
              {state.events}
            </dd>
            <dt className="text-muted-foreground">Artifacts</dt>
            <dd className="font-mono text-muted-foreground" data-testid="artifacts-count">
              0 <span className="ml-1">(v0.2: artifact index)</span>
            </dd>
          </dl>
        )}
      </CardContent>
    </Card>
  );
};