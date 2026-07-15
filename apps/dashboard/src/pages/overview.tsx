/**
 * apps/dashboard/src/pages/overview.tsx — home for the current Cognit root.
 *
 * No multi-project UI. The API process is bound to one root
 * (the directory you ran `cognit dashboard` from). This page only
 * lists sessions for that root.
 */
import { useEffect, useMemo, useState, type JSX } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Activity, CheckCircle2, Inbox, Pause, Plus } from "lucide-react";

import { Button } from "@/shared/ui/button";
import { Card, CardContent } from "@/shared/ui/card";
import { DataTable, type DataTableColumn } from "@/shared/ui/data-table";
import { EmptyState } from "@/shared/ui/empty-state";
import { ErrorState } from "@/shared/ui/error-state";
import { Skeleton } from "@/shared/ui/skeleton";
import { StatCard } from "@/shared/ui/stat-card";
import { StatusPill } from "@/shared/ui/status-pill";
import type { StatusKey } from "@/shared/config/status";
import { apiFetch, ApiError } from "@/lib/api-client";
import { formatIso } from "@/lib/format";
import { NewSessionDialog } from "@/components/NewSessionDialog";

type SessionRow = {
  readonly id: string;
  readonly project_id: string;
  readonly goal: string;
  readonly status: "active" | "paused" | "closed";
  readonly created_at: string;
  readonly closed_at?: string | null;
  readonly last_activity_at?: string | null;
};

type SessionsResp = { readonly sessions: ReadonlyArray<SessionRow> };

const SESSION_STATUS: Record<SessionRow["status"], StatusKey> = {
  active: "active",
  paused: "pending",
  closed: "archived",
};

const relativeTime = (iso: string | null | undefined): string => {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const diff = Date.now() - t;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
};

export const OverviewPage = (): JSX.Element => {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [sessions, setSessions] = useState<ReadonlyArray<SessionRow> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sessionDialogOpen, setSessionDialogOpen] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (searchParams.get("new") === "session") {
      setSessionDialogOpen(true);
      const next = new URLSearchParams(searchParams);
      next.delete("new");
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    apiFetch<SessionsResp>("/api/sessions")
      .then((s) => {
        if (cancelled) return;
        setSessions(s.sessions);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg =
          err instanceof ApiError
            ? err.message
            : err instanceof Error
              ? err.message
              : "Failed to load.";
        setError(msg);
      });
    return () => {
      cancelled = true;
    };
  }, [tick]);

  const stats = useMemo(() => {
    const list = sessions ?? [];
    return {
      total: list.length,
      active: list.filter((s) => s.status === "active").length,
      paused: list.filter((s) => s.status === "paused").length,
      closed: list.filter((s) => s.status === "closed").length,
    };
  }, [sessions]);

  const columns: ReadonlyArray<DataTableColumn<SessionRow>> = [
    {
      key: "goal",
      header: "Goal",
      render: (s) => (
        <button
          type="button"
          onClick={(e): void => {
            e.stopPropagation();
            navigate(`/timeline?session=${encodeURIComponent(s.id)}`);
          }}
          className="text-left font-medium hover:underline"
          data-testid="overview-session-goal"
        >
          {s.goal}
        </button>
      ),
    },
    {
      key: "status",
      header: "Status",
      width: "8rem",
      render: (s) => (
        <StatusPill status={SESSION_STATUS[s.status]} data-testid="overview-session-status" />
      ),
    },
    {
      key: "last_activity",
      header: "Last activity",
      width: "10rem",
      render: (s) => (
        <span
          className="font-mono text-xs text-muted-foreground"
          title={s.last_activity_at ?? s.created_at}
        >
          {relativeTime(s.last_activity_at ?? s.created_at)}
        </span>
      ),
    },
    {
      key: "created",
      header: "Created",
      width: "12rem",
      render: (s) => (
        <span className="font-mono text-xs text-muted-foreground">{formatIso(s.created_at)}</span>
      ),
    },
  ];

  if (error) {
    return (
      <ErrorState
        message={error}
        onRetry={(): void => {
          setError(null);
          setTick((n) => n + 1);
        }}
      />
    );
  }

  if (sessions === null) {
    return (
      <div className="flex flex-col gap-6" data-testid="overview-loading">
        <Skeleton className="h-8 w-64" />
        <div className="grid gap-4 sm:grid-cols-3">
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
        </div>
        <Skeleton className="h-64" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6" data-testid="overview-page">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Overview</h1>
          <p className="text-sm text-muted-foreground">
            Sessions in this Cognit root (the directory you started the dashboard from).
          </p>
        </div>
        <Button onClick={(): void => setSessionDialogOpen(true)} data-testid="overview-new-session">
          <Plus className="size-4" aria-hidden /> New session
        </Button>
      </header>

      <section className="grid gap-4 sm:grid-cols-3" data-testid="overview-stats">
        <StatCard label="Sessions" value={stats.total} icon={Activity} staggerIndex={0} />
        <StatCard label="Active" value={stats.active} icon={CheckCircle2} staggerIndex={1} />
        <StatCard
          label="Paused / closed"
          value={stats.paused + stats.closed}
          icon={Pause}
          staggerIndex={2}
        />
      </section>

      {sessions.length === 0 ? (
        <EmptyState
          icon={Inbox}
          title="No sessions yet"
          description="Create a session to record observations, decisions, and verifications for this root."
          action={
            <Button onClick={(): void => setSessionDialogOpen(true)}>
              <Plus className="size-4" aria-hidden /> New session
            </Button>
          }
        />
      ) : (
        <Card>
          <CardContent className="p-0">
            <DataTable columns={columns} rows={sessions} rowKey={(r) => r.id} emptyMessage="" />
          </CardContent>
        </Card>
      )}

      <NewSessionDialog
        open={sessionDialogOpen}
        onOpenChange={setSessionDialogOpen}
        onCreated={(sessionId): void => {
          setTick((n) => n + 1);
          navigate(`/timeline?session=${encodeURIComponent(sessionId)}`);
        }}
      />
    </div>
  );
};
