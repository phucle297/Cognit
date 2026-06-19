/**
 * apps/dashboard/src/pages/recovery-center.tsx — Recovery Center (6.8.2.P4).
 *
 * FSD layer: pages. Session picker + 3 DataTables (rejected
 * hypotheses / verified conclusions / accepted decisions). Per
 * row Button opens a Dialog confirmation before running the
 * recovery op (dry-run, export, snapshot). Canonical
 * empty/loading/error pattern.
 */
import { useEffect, useMemo, useState, type JSX } from "react";
import { AlertTriangle, Download, FileSearch2, ListChecks } from "lucide-react";

import { apiFetch, ApiError } from "@/lib/api-client";
import { Badge } from "@/shared/ui/badge";
import { Breadcrumb } from "@/shared/ui/breadcrumb";
import { Button } from "@/shared/ui/button";
import { Card, CardContent } from "@/shared/ui/card";
import { DataTable, type DataTableColumn } from "@/shared/ui/data-table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { EmptyState } from "@/shared/ui/empty-state";
import { ErrorState } from "@/shared/ui/error-state";
import { Skeleton } from "@/shared/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/select";
import { formatIso } from "@/lib/format";

type Session = {
  id: string;
  project_id: string;
  goal?: string;
  status: string;
  created_at: string;
};

type RecoveryRecord = {
  session_id: string;
  rejected_hypotheses: Array<{
    id: string;
    title: string;
    text: string;
    reason: string;
    reason_type: string;
    superseded_by_id: string | null;
    created_at: string;
  }>;
  verified_conclusions: Array<{
    id: string;
    text: string;
    verification_id: string;
    supporting_evidence_ids: string[];
    created_at: string;
  }>;
  accepted_decisions: Array<{
    id: string;
    text: string;
    based_on_conclusion_ids: string[];
    created_at: string;
  }>;
};

type OpKind = "dry_run" | "export" | "snapshot";

type PendingOp = { kind: OpKind; label: string; subject: string; sessionId: string } | null;

export const RecoveryCenterPage = (): JSX.Element => {
  const [sessions, setSessions] = useState<ReadonlyArray<Session> | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [recovery, setRecovery] = useState<RecoveryRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingOp>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch<{ sessions: Session[] }>("/api/sessions")
      .then((r) => {
        if (!cancelled) setSessions(r.sessions);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : "Failed to load.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (selectedId === null) {
      setRecovery(null);
      return;
    }
    let cancelled = false;
    setError(null);
    apiFetch<RecoveryRecord>(`/api/sessions/${encodeURIComponent(selectedId)}/recovery`)
      .then((rec) => {
        if (!cancelled) setRecovery(rec);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : "Failed to load recovery.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  const sessionGoal = useMemo(() => sessions?.find((s) => s.id === selectedId)?.goal ?? null, [sessions, selectedId]);

  if (error) {
    return (
      <div className="flex flex-col gap-3" data-testid="recovery-page">
        <Breadcrumb items={[{ label: "Cognit", href: "/" }, { label: "Recovery" }]} />
        <ErrorState message={error} onRetry={(): void => window.location.reload()} />
      </div>
    );
  }

  if (sessions === null) {
    return (
      <div className="flex flex-col gap-3" data-testid="recovery-page">
        <Breadcrumb items={[{ label: "Cognit", href: "/" }, { label: "Recovery" }]} />
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4" data-testid="recovery-page">
      <Breadcrumb items={[{ label: "Cognit", href: "/" }, { label: "Recovery" }]} />
      <Card>
        <CardContent className="flex items-center justify-between gap-3 p-4">
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground" htmlFor="recovery-session">
              Session
            </label>
            <Select
              value={selectedId ?? ""}
              onValueChange={(v: string) => setSelectedId(v || null)}
              disabled={sessions.length === 0}
            >
              <SelectTrigger id="recovery-session" className="w-96" data-testid="recovery-session-trigger">
                <SelectValue placeholder={sessions.length === 0 ? "No sessions" : "Select a session"} />
              </SelectTrigger>
              <SelectContent>
                {sessions.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.goal ? `${s.goal.slice(0, 64)} (${s.id.slice(0, 6)}…)` : s.id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="subtle"
              disabled={!selectedId}
              onClick={(): void =>
                setPending({
                  kind: "dry_run",
                  label: "Dry-run recovery",
                  subject: sessionGoal ?? selectedId ?? "",
                  sessionId: selectedId ?? "",
                })
              }
              data-testid="recovery-dry-run"
            >
              <FileSearch2 className="size-4" aria-hidden /> Dry-run
            </Button>
            <Button
              variant="subtle"
              disabled={!selectedId}
              onClick={(): void =>
                setPending({
                  kind: "snapshot",
                  label: "Snapshot session",
                  subject: sessionGoal ?? selectedId ?? "",
                  sessionId: selectedId ?? "",
                })
              }
              data-testid="recovery-snapshot"
            >
              <ListChecks className="size-4" aria-hidden /> Snapshot
            </Button>
            <Button
              disabled={!selectedId}
              onClick={(): void =>
                setPending({
                  kind: "export",
                  label: "Export recovery bundle",
                  subject: sessionGoal ?? selectedId ?? "",
                  sessionId: selectedId ?? "",
                })
              }
              data-testid="recovery-export"
            >
              <Download className="size-4" aria-hidden /> Export
            </Button>
          </div>
        </CardContent>
      </Card>

      {!selectedId ? (
        <EmptyState
          icon={FileSearch2}
          title="No session selected"
          description="Pick a session above to inspect its rejected hypotheses, verified conclusions, and accepted decisions."
        />
      ) : !recovery ? (
        <Skeleton className="h-64" />
      ) : (
        <div className="grid gap-4 lg:grid-cols-3" data-testid="recovery-grids">
          <RecoverySection
            title="Rejected hypotheses"
            icon={AlertTriangle}
            count={recovery.rejected_hypotheses.length}
            columns={[
              { key: "title", header: "Title", render: (h) => <span className="font-medium">{h.title}</span> },
              {
                key: "reason",
                header: "Reason",
                width: "10rem",
                render: (h) => (
                  <Badge variant={h.reason_type === "superseded" ? "archived" : "failed"}>{h.reason_type}</Badge>
                ),
              },
              {
                key: "created",
                header: "Created",
                width: "11rem",
                render: (h) => <span className="font-mono text-xs text-muted-foreground">{formatIso(h.created_at)}</span>,
              },
            ]}
            rows={recovery.rejected_hypotheses}
            rowKey={(h) => h.id}
            onAction={(h) =>
              setPending({
                kind: "dry_run",
                label: "Inspect rejection",
                subject: h.title,
                sessionId: selectedId,
              })
            }
          />
          <RecoverySection
            title="Verified conclusions"
            icon={FileSearch2}
            count={recovery.verified_conclusions.length}
            columns={[
              { key: "text", header: "Text", render: (c) => <span className="font-medium">{c.text}</span> },
              {
                key: "evidence",
                header: "Evidence",
                width: "8rem",
                render: (c) => <span className="font-mono text-xs">{c.supporting_evidence_ids.length}</span>,
              },
              {
                key: "created",
                header: "Verified",
                width: "11rem",
                render: (c) => <span className="font-mono text-xs text-muted-foreground">{formatIso(c.created_at)}</span>,
              },
            ]}
            rows={recovery.verified_conclusions}
            rowKey={(c) => c.id}
            onAction={(c) =>
              setPending({
                kind: "export",
                label: "Export conclusion",
                subject: c.text,
                sessionId: selectedId,
              })
            }
          />
          <RecoverySection
            title="Accepted decisions"
            icon={ListChecks}
            count={recovery.accepted_decisions.length}
            columns={[
              { key: "text", header: "Decision", render: (d) => <span className="font-medium">{d.text}</span> },
              {
                key: "based_on",
                header: "Based on",
                width: "8rem",
                render: (d) => <span className="font-mono text-xs">{d.based_on_conclusion_ids.length}</span>,
              },
              {
                key: "created",
                header: "Accepted",
                width: "11rem",
                render: (d) => <span className="font-mono text-xs text-muted-foreground">{formatIso(d.created_at)}</span>,
              },
            ]}
            rows={recovery.accepted_decisions}
            rowKey={(d) => d.id}
            onAction={(d) =>
              setPending({
                kind: "export",
                label: "Export decision",
                subject: d.text,
                sessionId: selectedId,
              })
            }
          />
        </div>
      )}

      <Dialog open={pending !== null} onOpenChange={(open) => !open && setPending(null)}>
        <DialogContent data-testid="recovery-confirm-dialog">
          <DialogHeader>
            <DialogTitle>{pending?.label}</DialogTitle>
            <DialogDescription>
              About to run <span className="font-mono">{pending?.kind}</span> on session{" "}
              <span className="font-mono">{pending?.sessionId.slice(0, 8)}…</span>.
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-md border bg-muted/40 p-3 text-sm">{pending?.subject}</div>
          <DialogFooter>
            <Button variant="subtle" onClick={(): void => setPending(null)}>
              Cancel
            </Button>
            <Button
              onClick={async (): Promise<void> => {
                if (!pending) return;
                try {
                  await apiFetch<unknown>(`/api/sessions/${encodeURIComponent(pending.sessionId)}/${pending.kind}`, {
                    method: "POST",
                    body: JSON.stringify({ subject: pending.subject }),
                  });
                } catch (err) {
                  console.error("[recovery] op failed", err);
                } finally {
                  setPending(null);
                }
              }}
              data-testid="recovery-confirm"
            >
              Confirm
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

type RecoverySectionProps<T> = {
  readonly title: string;
  readonly icon: typeof FileSearch2;
  readonly count: number;
  readonly columns: ReadonlyArray<DataTableColumn<T>>;
  readonly rows: ReadonlyArray<T>;
  readonly rowKey: (row: T) => string;
  readonly onAction: (row: T) => void;
};

const RecoverySection = <T,>({
  title,
  icon: Icon,
  count,
  columns,
  rows,
  rowKey,
  onAction,
}: RecoverySectionProps<T>): JSX.Element => (
  <Card>
    <CardContent className="flex flex-col gap-3 p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold tracking-tight">
          <Icon className="size-4 text-muted-foreground" aria-hidden /> {title}
        </h2>
        <Badge variant="neutral">{count}</Badge>
      </div>
      {count === 0 ? (
        <EmptyState icon={Icon} title="Empty" description="No entries in this group for the selected session." className="py-6" />
      ) : (
        <DataTable columns={columns} rows={rows} rowKey={rowKey} onRowClick={onAction} emptyMessage="" />
      )}
    </CardContent>
  </Card>
);
