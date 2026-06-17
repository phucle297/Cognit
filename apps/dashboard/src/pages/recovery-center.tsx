/**
 * apps/dashboard/src/pages/recovery-center.tsx — Recovery Center (6.6).
 *
 * FSD layer: pages. v0.2 stub (badge per plan.xml:846): session
 * picker + the 3 v0.1 field groups from /sessions/:id/recovery.
 * Fuzzy search, redaction editor, and export/import land in v0.2.
 */
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { apiFetch } from "@/lib/api-client";
import { Badge } from "@/shared/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/shared/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/select";

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

export const RecoveryCenterPage = (): JSX.Element => {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [recovery, setRecovery] = useState<RecoveryRecord | null>(null);
  const [loadingSessions, setLoadingSessions] = useState(true);
  const [loadingRecovery, setLoadingRecovery] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { sessions: list } = await apiFetch<{ sessions: Session[] }>("/sessions");
        if (!cancelled) {
          setSessions(list);
          setLoadingSessions(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "failed to load sessions");
          setLoadingSessions(false);
        }
      }
    })();
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
    setLoadingRecovery(true);
    setError(null);
    void (async () => {
      try {
        const rec = await apiFetch<RecoveryRecord>(
          `/sessions/${encodeURIComponent(selectedId)}/recovery`,
        );
        if (!cancelled) {
          setRecovery(rec);
          setLoadingRecovery(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "failed to load recovery");
          setLoadingRecovery(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle>Recovery Center</CardTitle>
        <Badge variant="secondary">v0.2</Badge>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <label className="text-sm font-medium" htmlFor="recovery-session">
            Session
          </label>
          <Select
            value={selectedId ?? ""}
            onValueChange={(v: string) => setSelectedId(v)}
            disabled={loadingSessions}
          >
            <SelectTrigger id="recovery-session">
              <SelectValue placeholder={loadingSessions ? "Loading…" : "Select a session"} />
            </SelectTrigger>
            <SelectContent>
              {sessions.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.id}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {error ? (
          <p className="text-sm text-destructive">Failed to load: {error}</p>
        ) : null}

        {selectedId === null ? (
          <p className="text-sm text-muted-foreground">
            Select a session to see its recovery record.
          </p>
        ) : loadingRecovery ? (
          <p className="text-sm text-muted-foreground">Loading recovery…</p>
        ) : recovery ? (
          <div className="grid gap-4 md:grid-cols-3">
            <RecoveryColumn
              heading="Rejected hypotheses"
              count={recovery.rejected_hypotheses.length}
            />
            <RecoveryColumn
              heading="Verified conclusions"
              count={recovery.verified_conclusions.length}
            />
            <RecoveryColumn
              heading="Accepted decisions"
              count={recovery.accepted_decisions.length}
            />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
};

const RecoveryColumn = ({
  heading,
  count,
}: {
  heading: string;
  count: number;
}): JSX.Element => (
  <Card>
    <CardHeader>
      <CardTitle className="text-base">{heading}</CardTitle>
    </CardHeader>
    <CardContent>
      <p className="font-mono text-sm" data-testid={`recovery-count-${heading.toLowerCase().replace(/\s+/g, "-")}`}>
        {count}
      </p>
    </CardContent>
  </Card>
);