/**
 * packages/db/src/verification-queries.ts
 *
 * Latest-verification selector used by the v0.2 recovery surface.
 * Given a session id, return a map from hypothesis id → the
 * most-recent verification summary (started row + terminal lifecycle
 * if one landed).
 *
 * Reads `verification_started` events with non-null
 * `linked_hypothesis_id` and the matching terminal event
 * (`verification_passed` / `_failed` / `_errored` / `_cancelled`)
 * when one exists. "Most recent" means highest `created_at`, then
 * highest `id` as the deterministic tiebreaker.
 *
 * The selector is read-only: no writes, no bus publishes, no
 * effect on the event log. The recovery route calls it once per
 * request and feeds the map into `@cognit/recovery/buildRecovery`.
 *
 * No DB migration required — `linked_hypothesis_id` already lives
 * on every `events` row (phase 5.6).
 */
import { Context, Effect, Layer } from "effect";
import { DbConnection } from "./context";
import { DbError, trySync } from "./errors";
import type { EventRow } from "./schema/rows";

export type VerificationLifecycle =
  | "started"
  | "passed"
  | "failed"
  | "errored"
  | "cancelled";

export interface LatestVerificationSummary {
  readonly id: string;
  readonly hypothesis_id: string;
  readonly type: "test" | "lint" | "build" | "exec" | "typecheck";
  readonly command: string;
  readonly state: VerificationLifecycle;
  readonly started_at: string;
  readonly ended_at: string | null;
}

export interface VerificationQueriesShape {
  readonly latestVerificationsForSession: (
    sessionId: string,
  ) => Effect.Effect<
    ReadonlyMap<string, LatestVerificationSummary>,
    DbError
  >;
}

export class VerificationQueries extends Context.Tag(
  "@cognit/db/VerificationQueries",
)<VerificationQueries, VerificationQueriesShape>() {}

const TERMINAL_TYPES: ReadonlySet<string> = new Set([
  "verification_passed",
  "verification_failed",
  "verification_errored",
  "verification_cancelled",
]);

const asString = (v: unknown): string => (typeof v === "string" ? v : "");

const lifecycleFromType = (t: string): VerificationLifecycle => {
  if (t === "verification_passed") return "passed";
  if (t === "verification_failed") return "failed";
  if (t === "verification_errored") return "errored";
  if (t === "verification_cancelled") return "cancelled";
  return "started";
};

/**
 * Live implementation. Queries events table directly via the
 * DbConnection — no full state replay, no SessionService round-trip.
 */
export const VerificationQueriesLive: Layer.Layer<
  VerificationQueries,
  never,
  DbConnection
> = Layer.effect(
  VerificationQueries,
  Effect.gen(function* () {
    const conn = yield* DbConnection;

    const latestVerificationsForSession = (
      sessionId: string,
    ): Effect.Effect<
      ReadonlyMap<string, LatestVerificationSummary>,
      DbError
    > =>
      Effect.gen(function* () {
        const rows = yield* trySync(
          () =>
            conn.handle.all<EventRow>(
              `SELECT id, type, payload_json, linked_hypothesis_id, created_at
                 FROM events
                WHERE session_id = ?
                  AND type IN ('verification_started',
                               'verification_passed',
                               'verification_failed',
                               'verification_errored',
                               'verification_cancelled')
             ORDER BY created_at ASC, id ASC`,
              [sessionId],
            ),
          (e) =>
            new DbError({
              message: "latestVerificationsForSession: query",
              cause: e,
            }),
        );

        if (rows.length === 0) return new Map<string, LatestVerificationSummary>();

        // Walk the ordered event stream. Track the most-recent
        // started row per hypothesis. When a terminal lands, attach
        // it to the matching started row in the same hypothesis
        // (the engine guarantees a started precedes its terminal,
        // and reruns emit a NEW started event — so we always pair
        // the terminal with the latest preceding started row).
        const startedByHyp = new Map<
          string,
          { id: string; type: string; command: string; startedAt: string }
        >();
        const terminalByStartedId = new Map<
          string,
          { state: VerificationLifecycle; endedAt: string }
        >();

        for (const r of rows) {
          if (r.type === "verification_started") {
            if (r.linked_hypothesis_id === null) continue;
            const payload = parseJson(r.payload_json);
            startedByHyp.set(r.linked_hypothesis_id, {
              id: r.id,
              type: asString(payload["type"]) || "exec",
              command: asString(payload["command"]),
              startedAt: r.created_at,
            });
            continue;
          }
          if (TERMINAL_TYPES.has(r.type)) {
            terminalByStartedId.set(r.id, {
              state: lifecycleFromType(r.type),
              endedAt: r.created_at,
            });
          }
        }

        // For each started row, find the terminal (if any) that
        // follows it by scanning terminals in chronological order.
        // The most-recent terminal that follows the started row is
        // the one we attach. If a rerun starts a NEW row before the
        // previous terminal lands, we still pair the previous
        // started with its terminal because started rows are
        // 1:1 with their terminals by `id` adjacency in the stream.
        const terminalRows = rows.filter((r) => TERMINAL_TYPES.has(r.type));

        const out = new Map<string, LatestVerificationSummary>();
        for (const [hypId, s] of startedByHyp) {
          // Find the FIRST terminal whose id is the immediate
          // successor of this started event in the stream (the
          // engine pairs them). To keep this selector free of any
          // cross-row linkage, we pair by stream-position: the
          // terminal whose row index in `rows` is the smallest
          // index strictly greater than this started row's index.
          const sIdx = rows.findIndex((r) => r.id === s.id);
          let matched: { state: VerificationLifecycle; endedAt: string } | null =
            null;
          for (let i = sIdx + 1; i < rows.length; i++) {
            const r = rows[i];
            if (!r) continue;
            if (!TERMINAL_TYPES.has(r.type)) continue;
            const t = terminalByStartedId.get(r.id);
            if (t) {
              matched = t;
              break;
            }
          }

          out.set(hypId, {
            id: s.id,
            hypothesis_id: hypId,
            type: (s.type as LatestVerificationSummary["type"]) || "exec",
            command: s.command,
            state: matched?.state ?? "started",
            started_at: s.startedAt,
            ended_at: matched?.endedAt ?? null,
          });
        }

        void terminalRows;
        return out;
      });

    return VerificationQueries.of({ latestVerificationsForSession });
  }),
);

const parseJson = (raw: string): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === "object" && parsed !== null) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  return {};
};
