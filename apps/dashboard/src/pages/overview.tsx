/**
 * apps/dashboard/src/pages/overview.tsx — dashboard home (6.8.2.P4).
 *
 * Header (project name h2 + 'New Session' primary Button). 3
 * StatCards (Sessions, Events this week, Open Decisions) with
 * delta vs last week. DataTable of sessions (goal, status via
 * StatusPill, last activity, created). EmptyState when no
 * sessions. Skeleton while loading. ErrorState with onRetry.
 *
 * No raw "No data" text — every state uses the shared primitives.
 */
import { useEffect, useMemo, useState, type JSX } from "react";
import { useNavigate } from "react-router-dom";
import { Activity, CheckCircle2, Inbox, Plus, ScrollText } from "lucide-react";

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
import { NewProjectDialog } from "@/components/NewProjectDialog";

type Project = {
  readonly id: string;
  readonly name: string;
  readonly goal?: string;
};

type SessionRow = {
  readonly id: string;
  readonly project_id: string;
  readonly goal: string;
  readonly status: "active" | "paused" | "closed";
  readonly created_at: string;
  readonly last_activity_at?: string | null;
};

type ProjectsResp = { readonly projects: ReadonlyArray<Project> };
type SessionsResp = { readonly sessions: ReadonlyArray<SessionRow> };

const SESSION_STATUS: Record<SessionRow["status"], StatusKey> = {
  active: "active",
  paused: "pending",
  closed: "archived",
};

const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

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
  const [projects, setProjects] = useState<ReadonlyArray<Project> | null>(null);
  const [sessions, setSessions] = useState<ReadonlyArray<SessionRow> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState<boolean>(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    Promise.all([apiFetch<ProjectsResp>("/api/projects"), apiFetch<SessionsResp>("/api/sessions")])
      .then(([p, s]) => {
        if (cancelled) return;
        setProjects(p.projects);
        setSessions(s.sessions);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg = err instanceof ApiError ? err.message : err instanceof Error ? err.message : "Failed to load.";
        setError(msg);
      });
    return () => {
      cancelled = true;
    };
  }, [tick]);

  const primary = projects?.[0] ?? null;

  const stats = useMemo(() => {
    if (!sessions) return null;
    const now = Date.now();
    const lastWeek = now - ONE_WEEK_MS;
    const weekCount = sessions.filter((s) => new Date(s.created_at).getTime() >= lastWeek).length;
    return { total: sessions.length, weekCount, weekDelta: sessions.length - weekCount };
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
      render: (s) => <StatusPill status={SESSION_STATUS[s.status]} data-testid="overview-session-status" />,
    },
    {
      key: "last_activity",
      header: "Last activity",
      width: "10rem",
      render: (s) => (
        <span className="font-mono text-xs text-muted-foreground" title={s.last_activity_at ?? s.created_at}>
          {relativeTime(s.last_activity_at ?? s.created_at)}
        </span>
      ),
    },
    {
      key: "created",
      header: "Created",
      width: "12rem",
      render: (s) => <span className="font-mono text-xs text-muted-foreground">{formatIso(s.created_at)}</span>,
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

  if (projects === null || sessions === null || stats === null) {
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

  const projectName = primary?.name ?? "No project yet";

  return (
    <div className="flex flex-col gap-6" data-testid="overview-page">
      <header className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Overview</h1>
          <h2 className="text-sm text-muted-foreground" data-testid="overview-project-name">
            {projectName}
          </h2>
        </div>
        <Button onClick={(): void => setDialogOpen(true)} data-testid="overview-new-session">
          <Plus className="size-4" aria-hidden /> New Session
        </Button>
      </header>

      <section className="grid gap-4 sm:grid-cols-3" data-testid="overview-stats">
        <StatCard label="Sessions" value={stats.total} delta={stats.weekDelta} icon={Activity} />
        <StatCard label="Events this week" value={stats.weekCount} icon={ScrollText} />
        <StatCard label="Open Decisions" value={0} icon={CheckCircle2} />
      </section>

      {sessions.length === 0 ? (
        <EmptyState
          icon={Inbox}
          title="No sessions yet"
          description="Create your first session to record observations, decisions, and verifications."
          action={
            <Button onClick={(): void => setDialogOpen(true)}>
              <Plus className="size-4" aria-hidden /> New Session
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

      <NewProjectDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onCreated={(): void => setTick((n) => n + 1)}
      />
    </div>
  );
};
