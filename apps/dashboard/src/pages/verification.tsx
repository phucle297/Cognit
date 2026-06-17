/**
 * apps/dashboard/src/pages/verification.tsx — Verification page (6.5).
 *
 * FSD layer: pages. Reads the session state via
 * `GET /sessions/:id/state` and groups verifications by their
 * `linked_hypothesis_id`. Each group is rendered with
 * `<VerificationList>`, whose rows expose Rerun and Cancel actions.
 *
 * Rerun → POST /verify (server starts a fresh
 * `verification_started` event; the row reflects the new id after
 * a refetch).
 * Cancel → POST /verify/:id/cancel. Disabled when the verification
 * state is terminal (passed / failed / errored / cancelled).
 *
 * Actor defaults to a stub `system` actor since v0.1 has no logged-in
 * user identity; a future revision can wire this to auth context.
 *
 * Session id source: `?session=<ulid>` in the URL search params.
 */
import { useMemo, type JSX } from "react";
import { useSearchParams } from "react-router-dom";
import { useApi } from "@/lib/use-api";
import { Card, CardContent, CardHeader, CardTitle } from "@/shared/ui/card";
import {
  VerificationList,
  type VerificationListItem,
} from "../components/VerificationList";
import type { ActorLike } from "../components/RerunButton";

type VerificationLifecycle = "started" | "passed" | "failed" | "errored" | "cancelled";

type VerificationStateShape = {
  readonly id: string;
  readonly command: string;
  readonly type: "test" | "lint" | "build" | "exec" | "typecheck";
  readonly linked_hypothesis_id: string | null;
  readonly state: VerificationLifecycle;
};

type StateResp = {
  readonly session: { readonly id: string };
  readonly state: {
    readonly verifications: Record<string, VerificationStateShape>;
  };
};

/**
 * Convert a server-serialized Map field (object keyed by entity id)
 * back into an array of values. See the snapshot service
 * `serializeState` for the wire format.
 */
const flattenMap = <T,>(input: Record<string, T> | undefined | null): T[] => {
  if (!input) return [];
  return Object.values(input);
};

export const VerificationPage = (): JSX.Element => {
  const [searchParams] = useSearchParams();
  const sessionId = searchParams.get("session");

  const statePath = sessionId ? `/sessions/${sessionId}/state` : null;
  const state = useApi<StateResp>(statePath);

  const verifications: ReadonlyArray<VerificationListItem> = useMemo(() => {
    if (!state.data?.state.verifications) return [];
    return flattenMap(state.data.state.verifications).map((v) => ({
      id: v.id,
      command: v.command,
      type: v.type,
      linked_hypothesis_id: v.linked_hypothesis_id ?? null,
      state: v.state,
    }));
  }, [state.data]);

  const grouped = useMemo<ReadonlyArray<[string, ReadonlyArray<VerificationListItem>]>>(() => {
    const map = new Map<string, VerificationListItem[]>();
    for (const v of verifications) {
      const key = v.linked_hypothesis_id ?? "(unlinked)";
      const bucket = map.get(key);
      if (bucket) bucket.push(v);
      else map.set(key, [v]);
    }
    return Array.from(map.entries());
  }, [verifications]);

  const actor: ActorLike = { name: "dashboard", type: "system" };

  if (!sessionId) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Verification</CardTitle>
        </CardHeader>
        <CardContent>
          <p data-testid="verification-empty-session" className="text-sm text-muted-foreground">
            Open a session to view its verifications.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div data-testid="verification-page" className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold">Verification</h1>
      {state.loading && verifications.length === 0 ? (
        <p className="text-sm text-muted-foreground">Loading verifications…</p>
      ) : null}
      {state.error ? (
        <p data-testid="verification-error" className="text-sm text-destructive">
          {state.error.api.message}
        </p>
      ) : null}

      {grouped.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No verifications in this session yet.
        </p>
      ) : (
        grouped.map(([hypId, items]) => (
          <section
            key={hypId}
            data-testid="verification-group"
            data-linked-hypothesis={hypId}
            className="flex flex-col gap-2"
          >
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Hypothesis {hypId} ({items.length})
            </h2>
            <VerificationList
              verifications={items}
              sessionId={sessionId}
              actor={actor}
            />
          </section>
        ))
      )}
    </div>
  );
};