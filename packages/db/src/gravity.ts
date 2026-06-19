/**
 * packages/db/src/gravity.ts — phase 8 v0.2 gravity selectors.
 *
 * `contributingActors(hypothesisId)` returns the unique
 * (actor_id, trust_score) pairs for every event that touches the
 * given hypothesis. "Touches" means:
 *
 *   - `linked_hypothesis_id = ?` (the dedicated cross-cutting
 *     column on every event row), OR
 *   - the event is a `verification_*` whose `linked_hypothesis_id`
 *     matches (already covered by the first clause — listed
 *     explicitly to make the join intent obvious).
 *
 * The selector is read-only and used by the gravity scorer to
 * compute `actor_trust` per the spec weights. Returns
 * `Effect.Effect<ReadonlyArray<ContributingActor>, DbError>`.
 *
 * Trust score source: `actors.trust_score` (REAL column on
 * `actors`, default 0 per `tables.ts:34`). Updated externally by
 * the trust-policy (not in scope for phase 8g.1).
 *
 * Distinct-ness: duplicate (actor_id, trust_score) pairs are
 * collapsed with `GROUP BY actor_id` and the row's current
 * `trust_score` is taken as the trust at the time of the call
 * (no historical tracking — the spec keeps things simple).
 *
 * Index: the existing `idx_events_linked_hyp` on
 * `(linked_hypothesis_id, created_at)` keeps this query O(log n)
 * for any non-trivial event log.
 */
import { Context, Effect, Layer } from "effect";
import { DbConnection } from "./context";
import { DbError, trySync } from "./errors";

export interface ContributingActor {
  readonly actor_id: string;
  readonly trust_score: number;
}

export interface GravityQueriesShape {
  readonly contributingActors: (
    hypothesisId: string,
  ) => Effect.Effect<ReadonlyArray<ContributingActor>, DbError>;
}

export class GravityQueries extends Context.Tag("@cognit/db/GravityQueries")<
  GravityQueries,
  GravityQueriesShape
>() {}

/**
 * Live implementation. Single SQL query joining events to actors
 * for the given hypothesis id. No state replay — the DB is the
 * single source of truth for "who touched what".
 */
export const GravityQueriesLive: Layer.Layer<GravityQueries, never, DbConnection> = Layer.effect(
  GravityQueries,
  Effect.gen(function* () {
    const conn = yield* DbConnection;

    const contributingActors = (
      hypothesisId: string,
    ): Effect.Effect<ReadonlyArray<ContributingActor>, DbError> =>
      Effect.gen(function* () {
        const rows = yield* trySync(
          () =>
            conn.handle.all<{ actor_id: string; trust_score: number }>(
              `SELECT a.id AS actor_id, a.trust_score
                 FROM events e
                 JOIN actors a ON a.id = e.actor_id
                WHERE e.linked_hypothesis_id = ?
                GROUP BY a.id`,
              [hypothesisId],
            ),
          (e) =>
            new DbError({
              message: "contributingActors: query",
              cause: e,
            }),
        );
        return rows.map((r) => ({
          actor_id: r.actor_id,
          trust_score: r.trust_score,
        }));
      });

    return GravityQueries.of({ contributingActors });
  }),
);
