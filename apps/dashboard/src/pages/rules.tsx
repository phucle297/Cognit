/**
 * apps/dashboard/src/pages/rules.tsx — phase 8 (8g.5) constraint
 * rules CRUD page.
 *
 * Code-split via React.lazy in `app/router.tsx`. Talks to
 * `/api/rules` (GET/POST/PATCH/DELETE).
 *
 * Features:
 *   - List all rules (collapsed by rule_id; soft-deleted hidden)
 *   - Add: paste JSON (validates client-side via JSON.parse + server
 *     re-validates the predicate against the closed v1 set)
 *   - Toggle enabled
 *   - Delete (soft)
 *   - Source badge: `yaml` vs `db`
 *
 * Local-only tool — no auth, no confirm modal for delete. The undo
 * path is `cognit constraint add` with the original JSON.
 */
import { useCallback, useEffect, useMemo, useState, type JSX } from "react";
import { Plus, Trash2 } from "lucide-react";
import { apiFetch, ApiError } from "@/lib/api-client";
import { Badge } from "@/shared/ui/badge";
import { Breadcrumb } from "@/shared/ui/breadcrumb";
import { Button } from "@/shared/ui/button";
import { Card, CardContent } from "@/shared/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/shared/ui/dialog";
import { EmptyState } from "@/shared/ui/empty-state";
import { ErrorState } from "@/shared/ui/error-state";
import { Skeleton } from "@/shared/ui/skeleton";

export interface RuleRow {
  readonly id: string;
  readonly session_id: string;
  readonly condition: unknown;
  readonly action: unknown;
  readonly reason: string;
  readonly enabled: boolean;
  readonly deleted: boolean;
  readonly source: "db" | "yaml";
  readonly created_at: string;
  readonly updated_at: string;
}

export const RulesPage = (): JSX.Element => {
  const [rules, setRules] = useState<ReadonlyArray<RuleRow> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      const r = await apiFetch<{ rules: RuleRow[] }>("/api/rules");
      setRules(r.rules);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Failed to load rules.",
      );
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleAdd = useCallback(
    async (json: string): Promise<void> => {
      setAddError(null);
      setSubmitting(true);
      let parsed: unknown;
      try {
        parsed = JSON.parse(json);
      } catch (e) {
        setAddError(`Invalid JSON: ${(e as Error).message}`);
        setSubmitting(false);
        return;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        setAddError("Body must be a JSON object with `when`, `then`, `reason`.");
        setSubmitting(false);
        return;
      }
      try {
        await apiFetch<{ rule: RuleRow }>("/api/rules", {
          method: "POST",
          body: parsed,
          headers: { "content-type": "application/json" },
        });
        setAddOpen(false);
        setDraft("");
        await load();
      } catch (err) {
        setAddError(
          err instanceof ApiError
            ? err.message
            : err instanceof Error
              ? err.message
              : "Add failed.",
        );
      } finally {
        setSubmitting(false);
      }
    },
    [load],
  );

  const handleToggle = useCallback(
    async (rule: RuleRow): Promise<void> => {
      try {
        await apiFetch<{ rule: RuleRow }>(
          `/api/rules/${encodeURIComponent(rule.id)}`,
          {
            method: "PATCH",
            body: { enabled: !rule.enabled },
            headers: { "content-type": "application/json" },
          },
        );
        await load();
      } catch (err) {
        setError(
          err instanceof ApiError
            ? err.message
            : err instanceof Error
              ? err.message
              : "Toggle failed.",
        );
      }
    },
    [load],
  );

  const handleDelete = useCallback(
    async (rule: RuleRow): Promise<void> => {
      try {
        await apiFetch<{ id: string }>(`/api/rules/${encodeURIComponent(rule.id)}`, {
          method: "DELETE",
        });
        await load();
      } catch (err) {
        setError(
          err instanceof ApiError
            ? err.message
            : err instanceof Error
              ? err.message
              : "Delete failed.",
        );
      }
    },
    [load],
  );

  const sample = useMemo(
    () =>
      JSON.stringify(
        {
          when: { kind: "event.type", equals: "observation_recorded" },
          then: { kind: "block" },
          reason: "block raw observations in this session",
        },
        null,
        2,
      ),
    [],
  );

  if (error) {
    return (
      <div className="flex flex-col gap-3" data-testid="rules-page">
        <Breadcrumb items={[{ label: "Cognit", href: "/" }, { label: "Rules" }]} />
        <ErrorState message={error} onRetry={(): void => void load()} />
      </div>
    );
  }

  if (rules === null) {
    return (
      <div className="flex flex-col gap-3" data-testid="rules-page">
        <Breadcrumb items={[{ label: "Cognit", href: "/" }, { label: "Rules" }]} />
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4" data-testid="rules-page">
      <Breadcrumb items={[{ label: "Cognit", href: "/" }, { label: "Rules" }]} />

      <Card>
        <CardContent className="flex items-center justify-between gap-2 p-4">
          <div>
            <h1 className="text-base font-semibold">Constraint Rules</h1>
            <p className="text-xs text-muted-foreground">
              Manage the rules the constraint engine evaluates on every event append.
            </p>
          </div>
          <Dialog open={addOpen} onOpenChange={(open: boolean): void => setAddOpen(open)}>
            <DialogTrigger asChild>
              <Button size="sm" data-testid="rules-add-button">
                <Plus className="size-4" aria-hidden /> Add rule
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Add constraint rule</DialogTitle>
                <DialogDescription>
                  Paste a JSON rule with <code>when</code>, <code>then</code>, and{" "}
                  <code>reason</code>. The server re-validates the predicate.
                </DialogDescription>
              </DialogHeader>
              <textarea
                className="font-mono text-xs min-h-48 rounded border bg-muted/30 p-2"
                data-testid="rules-add-json"
                value={draft.length === 0 ? sample : draft}
                onChange={(e): void => setDraft(e.target.value)}
              />
              {addError !== null && (
                <p className="text-xs text-destructive" data-testid="rules-add-error">
                  {addError}
                </p>
              )}
              <DialogFooter>
                <Button variant="outline" onClick={(): void => setAddOpen(false)}>
                  Cancel
                </Button>
                <Button
                  disabled={submitting}
                  data-testid="rules-add-submit"
                  onClick={(): void => void handleAdd(draft.length === 0 ? sample : draft)}
                >
                  {submitting ? "Adding…" : "Add rule"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </CardContent>
      </Card>

      {rules.length === 0 ? (
        <EmptyState
          icon={Plus}
          title="No rules yet"
          description="Constraint rules are evaluated on every event append. Add one to begin."
          className="py-10"
          data-testid="rules-empty"
        />
      ) : (
        <ul className="flex flex-col gap-2" data-testid="rules-list">
          {rules.map((rule) => (
            <li key={rule.id} data-testid={`rules-item-${rule.id}`}>
              <Card>
                <CardContent className="flex items-start justify-between gap-3 p-4">
                  <div className="flex min-w-0 flex-col gap-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{rule.id}</span>
                      <Badge
                        variant={rule.source === "db" ? "verified" : "neutral"}
                        data-testid={`rules-source-${rule.id}`}
                      >
                        {rule.source}
                      </Badge>
                      <Badge
                        variant={rule.enabled ? "active" : "archived"}
                        data-testid={`rules-enabled-${rule.id}`}
                      >
                        {rule.enabled ? "enabled" : "disabled"}
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground">{rule.reason}</p>
                    <pre className="rounded border bg-muted/40 p-2 font-mono text-xs">
                      {JSON.stringify(
                        { when: rule.condition, then: rule.action },
                        null,
                        2,
                      )}
                    </pre>
                  </div>
                  <div className="flex flex-shrink-0 flex-col gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={(): void => void handleToggle(rule)}
                      data-testid={`rules-toggle-${rule.id}`}
                    >
                      {rule.enabled ? "Disable" : "Enable"}
                    </Button>
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={(): void => void handleDelete(rule)}
                      data-testid={`rules-delete-${rule.id}`}
                    >
                      <Trash2 className="size-4" aria-hidden /> Delete
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
