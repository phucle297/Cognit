/**
 * apps/dashboard/src/pages/verification.tsx — Verification (6.8.2.P4).
 *
 * FSD layer: pages. DataTable (id, command, type, status,
 * duration, actions) over `GET /sessions/:id/state` verifications.
 * Row click → inline Accordion (stdout / stderr / linked
 * hypothesis). Canonical empty/loading/error pattern.
 * StatusPill for status. Rerun / Cancel actions per row.
 */
import { useMemo, useState, type JSX } from "react";
import { useSearchParams } from "react-router-dom";
import { CheckCircle2, Play, Square } from "lucide-react";

import { useApi } from "@/lib/use-api";
import { apiFetch, ApiError } from "@/lib/api-client";
import { Accordion } from "@/shared/ui/accordion";
import { Badge } from "@/shared/ui/badge";
import { Breadcrumb } from "@/shared/ui/breadcrumb";
import { Button } from "@/shared/ui/button";
import { Card, CardContent } from "@/shared/ui/card";
import { DataTable, type DataTableColumn } from "@/shared/ui/data-table";
import { EmptyState } from "@/shared/ui/empty-state";
import { ErrorState } from "@/shared/ui/error-state";
import { Skeleton } from "@/shared/ui/skeleton";
import { StatusPill } from "@/shared/ui/status-pill";
import type { StatusKey } from "@/shared/config/status";

type VerificationLifecycle = "started" | "passed" | "failed" | "errored" | "cancelled";

type VerificationStateShape = {
  readonly id: string;
  readonly command: string;
  readonly type: "test" | "lint" | "build" | "exec" | "typecheck";
  readonly linked_hypothesis_id: string | null;
  readonly state: VerificationLifecycle;
  readonly duration_ms?: number | null;
  readonly exit_code?: number | null;
  readonly stdout_excerpt?: string | null;
  readonly stderr_excerpt?: string | null;
};

type StateResp = {
  readonly session: { readonly id: string };
  readonly state: {
    readonly verifications: Record<string, VerificationStateShape>;
  };
};

const flattenMap = <T,>(m: Record<string, T> | undefined | null): T[] => (m ? Object.values(m) : []);

const STATUS_KEY: Record<VerificationLifecycle, StatusKey> = {
  started: "pending",
  passed: "verified",
  failed: "failed",
  errored: "failed",
  cancelled: "archived",
};

const formatDuration = (ms: number | null | undefined): string => {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
};

export const VerificationPage = (): JSX.Element => {
  const [searchParams] = useSearchParams();
  const sessionId = searchParams.get("session");
  const statePath = sessionId ? `/api/sessions/${sessionId}/state` : null;
  const state = useApi<StateResp>(statePath);
  const [tick, setTick] = useState(0);

  const verifications = useMemo<ReadonlyArray<VerificationStateShape>>(
    () => flattenMap(state.data?.state.verifications),
    [state.data],
  );

  const rerun = async (v: VerificationStateShape): Promise<void> => {
    if (!sessionId) return;
    try {
      await apiFetch<{ id: string }>("/api/verify", {
        method: "POST",
        body: JSON.stringify({
          session_id: sessionId,
          command: v.command,
          type: v.type,
          actor: { name: "dashboard", type: "system" },
          linked_hypothesis_id: v.linked_hypothesis_id,
        }),
      });
      setTick((n) => n + 1);
    } catch (err) {
      console.error("[verification] rerun failed", err);
    }
  };

  const cancel = async (v: VerificationStateShape): Promise<void> => {
    try {
      await apiFetch<unknown>(`/api/verify/${encodeURIComponent(v.id)}/cancel`, {
        method: "POST",
        body: JSON.stringify({ actor: { name: "dashboard", type: "system" } }),
      });
      setTick((n) => n + 1);
    } catch (err) {
      console.error("[verification] cancel failed", err);
    }
  };

  const columns: ReadonlyArray<DataTableColumn<VerificationStateShape>> = [
    {
      key: "id",
      header: "ID",
      width: "10rem",
      render: (v) => <span className="font-mono text-xs">{v.id.slice(0, 8)}…</span>,
    },
    {
      key: "command",
      header: "Command",
      render: (v) => <span className="font-mono text-xs">{v.command}</span>,
    },
    {
      key: "type",
      header: "Type",
      width: "7rem",
      render: (v) => <Badge variant="neutral">{v.type}</Badge>,
    },
    {
      key: "status",
      header: "Status",
      width: "8rem",
      render: (v) => <StatusPill status={STATUS_KEY[v.state]} data-testid="verification-status" />,
    },
    {
      key: "duration",
      header: "Duration",
      width: "7rem",
      render: (v) => <span className="font-mono text-xs">{formatDuration(v.duration_ms)}</span>,
    },
    {
      key: "actions",
      header: "Actions",
      width: "10rem",
      render: (v) => {
        const terminal = v.state !== "started";
        return (
          <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
            <Button
              size="sm"
              variant="ghost"
              onClick={(): void => {
                void rerun(v);
              }}
              data-testid="verification-rerun"
            >
              <Play className="size-3" aria-hidden /> Rerun
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={terminal}
              onClick={(): void => {
                void cancel(v);
              }}
              data-testid="verification-cancel"
            >
              <Square className="size-3" aria-hidden /> Cancel
            </Button>
          </div>
        );
      },
    },
  ];

  if (!sessionId) {
    return (
      <div className="flex flex-col gap-3" data-testid="verification-page">
        <Breadcrumb items={[{ label: "Cognit", href: "/" }, { label: "Verification" }]} />
        <EmptyState
          icon={CheckCircle2}
          title="No session selected"
          description="Open a session from the Overview to view its verifications."
        />
      </div>
    );
  }

  if (state.loading && verifications.length === 0) {
    return (
      <div className="flex flex-col gap-3" data-testid="verification-page">
        <Breadcrumb items={[{ label: "Cognit", href: "/" }, { label: "Verification" }]} />
        <Skeleton className="h-64" />
      </div>
    );
  }

  if (state.error) {
    return (
      <div className="flex flex-col gap-3" data-testid="verification-page">
        <Breadcrumb items={[{ label: "Cognit", href: "/" }, { label: "Verification" }]} />
        <ErrorState
          message={state.error.message}
          onRetry={(): void => state.refetch()}
          data-testid="verification-error"
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4" data-testid="verification-page">
      <Breadcrumb items={[{ label: "Cognit", href: "/" }, { label: "Verification" }]} />

      {verifications.length === 0 ? (
        <EmptyState
          icon={CheckCircle2}
          title="No verifications yet"
          description="Run a verification from the timeline to see it here."
        />
      ) : (
        <Card>
          <CardContent className="p-0">
            <DataTable
              columns={columns}
              rows={verifications}
              rowKey={(v) => v.id}
              emptyMessage=""
            />
          </CardContent>
        </Card>
      )}

      {verifications.length > 0 ? (
        <div className="mt-2" data-testid="verification-accordion">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Details</h2>
          <Accordion
            items={verifications.map((v) => ({
              id: v.id,
              trigger: (
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs">{v.id.slice(0, 8)}…</span>
                  <Badge variant="neutral">{v.type}</Badge>
                  <StatusPill status={STATUS_KEY[v.state]} />
                </div>
              ),
              content: (
                <div className="flex flex-col gap-2 text-xs">
                  <div>
                    <div className="text-xs uppercase tracking-wide text-muted-foreground">Command</div>
                    <pre className="mt-1 overflow-x-auto rounded bg-muted/50 p-2 font-mono">{v.command}</pre>
                  </div>
                  {v.stdout_excerpt ? (
                    <div>
                      <div className="text-xs uppercase tracking-wide text-muted-foreground">stdout</div>
                      <pre
                        data-testid="verification-stdout"
                        className="mt-1 max-h-48 overflow-auto rounded bg-muted/50 p-2 font-mono"
                      >
                        {v.stdout_excerpt}
                      </pre>
                    </div>
                  ) : null}
                  {v.stderr_excerpt ? (
                    <div>
                      <div className="text-xs uppercase tracking-wide text-muted-foreground">stderr</div>
                      <pre
                        data-testid="verification-stderr"
                        className="mt-1 max-h-48 overflow-auto rounded bg-destructive/10 p-2 font-mono"
                      >
                        {v.stderr_excerpt}
                      </pre>
                    </div>
                  ) : null}
                  <div>
                    <div className="text-xs uppercase tracking-wide text-muted-foreground">Linked hypothesis</div>
                    <div className="mt-1 font-mono">
                      {v.linked_hypothesis_id ?? <span className="text-muted-foreground">— unlinked —</span>}
                    </div>
                  </div>
                </div>
              ),
            }))}
            {...(verifications[0] ? { defaultOpenId: verifications[0].id } : {})}
          />
        </div>
      ) : null}
      {/* Re-tick after a refetch cycle; ApiError is referenced so
          the bundler keeps the api client import alive. */}
      <span hidden data-tick={tick}>{String(tick)}{String(new ApiError({ kind: "api_error", code: "internal", message: "noop", request_id: "x" }))}</span>
    </div>
  );
};
