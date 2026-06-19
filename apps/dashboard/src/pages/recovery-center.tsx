/**
 * apps/dashboard/src/pages/recovery-center.tsx — Recovery Center v0.2.
 *
 * FSD layer: pages. Session picker + 8 DataTable/sections (matches the
 * server's v0.2 envelope). Per-row Button opens a Dialog confirmation
 * before running the recovery op (dry-run, export, snapshot).
 * Canonical empty/loading/error pattern.
 */
import { useEffect, useMemo, useState, type JSX } from "react";
import { AlertTriangle, Download, FileSearch2, History, ListChecks, Network, Sparkles } from "lucide-react";

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
import { Input } from "@/shared/ui/input";
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

/** A single result row from `/api/sessions/search`. */
type SearchResult = {
  session_id: string;
  kind: string;
  entity_id: string;
  score: number;
  text: string;
  kind_weight: number;
};

/**
 * v0.2 recovery envelope — 8 top-level fields. Mirrors the server's
 * `buildRecovery(...)` output (snake_case wire keys).
 */
type RecoveryRecord = {
  session_id: string;
  related_sessions: Array<{
    id: string;
    score: number;
    matched_on: string;
  }>;
  rejected_hypotheses: Array<{
    id: string;
    title: string;
    text: string;
    reason: string | null;
    reason_type: "evidence" | "superseded" | "constraint" | null;
    superseded_by_id: string | null;
    created_at: string;
  }>;
  verified_conclusions: Array<{
    id: string;
    text: string;
    verification_id: string | null;
    supporting_evidence_ids: string[];
    created_at: string;
  }>;
  accepted_decisions: Array<{
    id: string;
    text: string;
    based_on_conclusion_ids: string[];
    created_at: string;
  }>;
  rejected_decisions: Array<{
    id: string;
    text: string;
    reason: string;
    created_at: string;
  }>;
  latest_verification: Record<
    string,
    {
      id: string;
      hypothesis_id: string;
      type: "test" | "lint" | "build" | "exec" | "typecheck";
      command: string;
      state: "started" | "passed" | "failed" | "errored" | "cancelled";
      started_at: string;
      ended_at: string | null;
    }
  >;
  /** Full SessionState blob — rendered as pretty JSON. */
  last_known_state: unknown;
  suggested_next_steps: Array<{ id: string; text: string; score: number }>;
};

type OpKind = "dry_run" | "export" | "snapshot";

type PendingOp = { kind: OpKind; label: string; subject: string; sessionId: string } | null;

export const RecoveryCenterPage = (): JSX.Element => {
  const [sessions, setSessions] = useState<ReadonlyArray<Session> | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [recovery, setRecovery] = useState<RecoveryRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingOp>(null);

  // Search state — submit-on-Enter to /api/sessions/search
  const [searchTerm, setSearchTerm] = useState("");
  const [searchResults, setSearchResults] = useState<ReadonlyArray<SearchResult> | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);

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

  const runSearch = async (term: string): Promise<void> => {
    const q = term.trim();
    if (q.length === 0) {
      setSearchResults(null);
      setSearchError(null);
      return;
    }
    setSearching(true);
    setSearchError(null);
    try {
      const r = await apiFetch<{ results: SearchResult[] }>(
        `/api/sessions/search?q=${encodeURIComponent(q)}&limit=50`,
      );
      setSearchResults(r.results);
    } catch (err) {
      setSearchError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : "Search failed");
      setSearchResults(null);
    } finally {
      setSearching(false);
    }
  };

  const handleSearchSubmit = (e: React.FormEvent<HTMLFormElement>): void => {
    e.preventDefault();
    void runSearch(searchTerm);
  };

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
        <CardContent className="flex flex-col gap-3 p-4">
          <div className="flex items-center justify-between gap-3">
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
          </div>

          {/* Search input → /api/sessions/search */}
          <form
            className="flex items-center gap-2"
            onSubmit={handleSearchSubmit}
            data-testid="recovery-search-form"
          >
            <Input
              type="search"
              value={searchTerm}
              onChange={(e): void => setSearchTerm(e.target.value)}
              placeholder="Search sessions, hypotheses, conclusions…"
              className="w-96"
              data-testid="recovery-search-input"
              aria-label="Search sessions"
            />
            <Button type="submit" disabled={searching} data-testid="recovery-search-submit">
              {searching ? "Searching…" : "Search"}
            </Button>
          </form>

          {searchError ? (
            <p className="text-xs text-destructive" data-testid="recovery-search-error">
              {searchError}
            </p>
          ) : null}

          {searchResults !== null ? (
            <div className="flex flex-col gap-1" data-testid="recovery-search-results">
              <p className="text-xs text-muted-foreground">
                {searchResults.length} result{searchResults.length === 1 ? "" : "s"}
              </p>
              {searchResults.length === 0 ? (
                <EmptyState
                  icon={FileSearch2}
                  title="No matches"
                  description="Try a different query or remove filters."
                  className="py-4"
                />
              ) : (
                <ul className="flex max-h-64 flex-col gap-1 overflow-y-auto rounded-md border p-2">
                  {searchResults.map((r) => (
                    <li key={`${r.session_id}:${r.entity_id}:${r.kind}`}>
                      <button
                        type="button"
                        onClick={(): void => setSelectedId(r.session_id)}
                        className="flex w-full items-center justify-between gap-3 rounded px-2 py-1.5 text-left text-sm hover:bg-muted/50"
                        data-testid="recovery-search-result"
                        data-session-id={r.session_id}
                      >
                        <span className="flex flex-col">
                          <span className="font-medium">{r.text}</span>
                          <span className="font-mono text-xs text-muted-foreground">
                            {r.kind} · {r.session_id.slice(0, 8)}…
                          </span>
                        </span>
                        <Badge variant="neutral">{r.score.toFixed(2)}</Badge>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : null}
        </CardContent>
      </Card>

      {!selectedId ? (
        <EmptyState
          icon={FileSearch2}
          title="No session selected"
          description="Pick a session above or use the search box to find one by content."
        />
      ) : !recovery ? (
        <Skeleton className="h-64" />
      ) : (
        <div className="grid gap-4 lg:grid-cols-3" data-testid="recovery-grids">
          <RecoverySection
            title="Related sessions"
            icon={Network}
            count={recovery.related_sessions.length}
            columns={[
              {
                key: "id",
                header: "Session",
                render: (r) => <span className="font-mono text-xs">{r.id.slice(0, 12)}…</span>,
              },
              {
                key: "score",
                header: "Score",
                width: "6rem",
                render: (r) => <span className="font-mono text-xs">{r.score.toFixed(2)}</span>,
              },
              {
                key: "matched_on",
                header: "Matched on",
                render: (r) => <span className="text-sm">{r.matched_on}</span>,
              },
            ]}
            rows={recovery.related_sessions}
            rowKey={(r) => r.id}
            onAction={(r) => setSelectedId(r.id)}
          />
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
                  <Badge variant={h.reason_type === "superseded" ? "archived" : "failed"}>
                    {h.reason_type ?? "unknown"}
                  </Badge>
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
          <RecoverySection
            title="Rejected decisions"
            icon={AlertTriangle}
            count={recovery.rejected_decisions.length}
            columns={[
              { key: "text", header: "Decision", render: (d) => <span className="font-medium">{d.text}</span> },
              { key: "reason", header: "Reason", render: (d) => <span className="text-sm">{d.reason}</span> },
              {
                key: "created",
                header: "Created",
                width: "11rem",
                render: (d) => <span className="font-mono text-xs text-muted-foreground">{formatIso(d.created_at)}</span>,
              },
            ]}
            rows={recovery.rejected_decisions}
            rowKey={(d) => d.id}
            onAction={(d) =>
              setPending({
                kind: "export",
                label: "Export rejected decision",
                subject: d.text,
                sessionId: selectedId,
              })
            }
          />
          <LatestVerificationCard data={recovery.latest_verification} />
          <LastKnownStateCard data={recovery.last_known_state} />
          <SuggestedNextStepsCard items={recovery.suggested_next_steps} />
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

/** Inline display for the `latest_verification` map (keyed by hypothesis id). */
const LatestVerificationCard = ({
  data,
}: {
  readonly data: RecoveryRecord["latest_verification"];
}): JSX.Element => {
  const entries = Object.entries(data);
  return (
    <Card>
      <CardContent className="flex flex-col gap-3 p-4">
        <div className="flex items-center justify-between gap-2">
          <h2 className="flex items-center gap-2 text-sm font-semibold tracking-tight">
            <History className="size-4 text-muted-foreground" aria-hidden /> Latest verification
          </h2>
          <Badge variant="neutral">{entries.length}</Badge>
        </div>
        {entries.length === 0 ? (
          <EmptyState
            icon={History}
            title="Empty"
            description="No verifications have run for this session."
            className="py-6"
          />
        ) : (
          <dl className="flex flex-col gap-3 text-sm" data-testid="recovery-latest-verification">
            {entries.map(([hypId, v]) => (
              <div key={hypId} className="rounded-md border p-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-xs text-muted-foreground">{hypId.slice(0, 12)}…</span>
                  <Badge variant={v.state === "passed" ? "archived" : v.state === "failed" || v.state === "errored" ? "failed" : "neutral"}>
                    {v.state}
                  </Badge>
                </div>
                <div className="mt-1 flex flex-col gap-0.5">
                  <div className="font-mono text-xs">{v.type}: {v.command}</div>
                  <div className="text-xs text-muted-foreground">
                    started {formatIso(v.started_at)}
                    {v.ended_at ? ` · ended ${formatIso(v.ended_at)}` : " · running"}
                  </div>
                </div>
              </div>
            ))}
          </dl>
        )}
      </CardContent>
    </Card>
  );
};

/** Inline display for `last_known_state` (full SessionState, pretty JSON). */
const LastKnownStateCard = ({
  data,
}: {
  readonly data: unknown;
}): JSX.Element => {
  const pretty = useMemo(() => {
    try {
      return JSON.stringify(data, null, 2);
    } catch {
      return String(data);
    }
  }, [data]);
  return (
    <Card>
      <CardContent className="flex flex-col gap-3 p-4">
        <div className="flex items-center justify-between gap-2">
          <h2 className="flex items-center gap-2 text-sm font-semibold tracking-tight">
            <FileSearch2 className="size-4 text-muted-foreground" aria-hidden /> Last known state
          </h2>
        </div>
        <pre
          className="max-h-80 overflow-auto rounded-md border bg-muted/40 p-2 font-mono text-xs"
          data-testid="recovery-last-known-state"
        >
          {pretty}
        </pre>
      </CardContent>
    </Card>
  );
};

/**
 * Suggested Next Steps card — phase 8 (8g.5).
 *
 * Renders each ranked active hypothesis as (id, text, score) with a
 * color-graded score badge:
 *   score >= 0.7 → high   (success)
 *   score >= 0.4 → mid    (warning)
 *   score <  0.4 → low    (neutral)
 *
 * Empty state copy: "No active hypotheses. Add one to get
 * gravity-ranked suggestions." (no phase 8 wording per AC).
 */
const scoreBucket = (score: number): { variant: "verified" | "pending" | "neutral"; label: string } => {
  if (score >= 0.7) return { variant: "verified", label: "high" };
  if (score >= 0.4) return { variant: "pending", label: "mid" };
  return { variant: "neutral", label: "low" };
};

const SuggestedNextStepsCard = ({
  items,
}: {
  readonly items: RecoveryRecord["suggested_next_steps"];
}): JSX.Element => {
  return (
    <Card>
      <CardContent className="flex flex-col gap-3 p-4">
        <div className="flex items-center justify-between gap-2">
          <h2 className="flex items-center gap-2 text-sm font-semibold tracking-tight">
            <Sparkles className="size-4 text-muted-foreground" aria-hidden /> Suggested next steps
          </h2>
          <Badge variant="neutral">{items.length}</Badge>
        </div>
        {items.length === 0 ? (
          <EmptyState
            icon={Sparkles}
            title="Empty"
            description="No active hypotheses. Add one to get gravity-ranked suggestions."
            className="py-6"
            data-testid="recovery-suggested-empty"
          />
        ) : (
          <ul className="flex flex-col gap-2 text-sm" data-testid="recovery-suggested-list">
            {items.map((step) => {
              const b = scoreBucket(step.score);
              return (
                <li
                  key={step.id}
                  className="flex items-start justify-between gap-2 rounded border p-2"
                  data-testid={`recovery-suggested-item-${step.id}`}
                >
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate font-medium">{step.text}</span>
                    <span className="truncate text-xs text-muted-foreground">{step.id}</span>
                  </div>
                  <Badge variant={b.variant} data-testid={`recovery-suggested-score-${step.id}`}>
                    {b.label} {step.score.toFixed(3)}
                  </Badge>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
};
