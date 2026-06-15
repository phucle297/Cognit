/**
 * ConstraintPolicy — Context.Tag that yields the constraint rules
 * currently in effect for a given session.
 *
 * The Live layer reads past `constraint_rule_added` events for the
 * session from the EventStore, decodes their `condition_json` and
 * `actions_json` payloads, and exposes the resulting list. The
 * `SessionService.appendEvent` chokepoint yields this tag, then
 * asks for the rules + the current state, then runs the pure
 * `evalRules` function (see `constraint-engine.ts`).
 *
 * The policy is loaded FRESH on every append (no caching). The
 * EventStore is the source of truth; a stale cache is the wrong
 * trade-off for a 13-predicate closed vocabulary.
 */

import { Context, Effect, Layer } from "effect";
import type { EngineRule } from "./constraint-engine.js";
import { decodePredicate } from "./constraint-engine.js";
import { DbError } from "./errors.js";
import { EventStore } from "./context.js";

export interface ConstraintPolicyShape {
  /**
   * Read the constraint rules currently in effect for `sessionId`.
   * Loads every `constraint_rule_added` event for the session, decodes
   * the wire form, and returns the resulting list (in append order;
   * the engine evaluates in this order).
   */
  readonly loadRules: (sessionId: string) => Effect.Effect<ReadonlyArray<EngineRule>, DbError>;
}

export class ConstraintPolicy extends Context.Tag("@cognit/db/ConstraintPolicy")<
  ConstraintPolicy,
  ConstraintPolicyShape
>() {}

/**
 * Live layer. Depends only on `EventStore`; the policy is a thin
 * read-side helper. The chokepoint (`SessionService.appendEvent`)
 * depends on this tag.
 */
export const ConstraintPolicyLive: Layer.Layer<ConstraintPolicy, never, EventStore> = Layer.effect(
  ConstraintPolicy,
  Effect.gen(function* () {
    const store = yield* EventStore;
    return {
      loadRules: (sessionId) =>
        Effect.gen(function* () {
          // Fetch all events for the session; filter to rule-add
          // events; decode each rule.
          const all = yield* store.list({ sessionId, type: "constraint_rule_added" }).pipe(
            Effect.mapError(
              (e) => new DbError({ message: "ConstraintPolicy.loadRules: list", cause: e }),
            ),
          );
          const ruleEvents = all.events;
          const out: EngineRule[] = [];
          for (const ev of ruleEvents) {
            if (ev.type !== "constraint_rule_added") continue;
            let payload: unknown;
            try {
              payload = JSON.parse(ev.payload_json);
            } catch {
              return yield* Effect.fail(
                new DbError({
                  message: `ConstraintPolicy.loadRules: bad payload_json on event ${ev.id}`,
                }),
              );
            }
            if (!payload || typeof payload !== "object") continue;
            const p = payload as Record<string, unknown>;
            const ruleId = typeof p.rule_id === "string" ? p.rule_id : ev.id;
            const reason = typeof p.reason === "string" ? p.reason : "(no reason)";
            const condition = typeof p.condition_json === "string" ? p.condition_json : null;
            const action = typeof p.actions_json === "string" ? p.actions_json : null;
            if (!condition || !action) continue;
            let decoded;
            try {
              decoded = decodePredicate(condition);
            } catch (e) {
              return yield* Effect.fail(
                new DbError({
                  message: `ConstraintPolicy.loadRules: bad condition_json on event ${ev.id}: ${(e as Error).message}`,
                }),
              );
            }
            // v1 only has one action shape; accept anything parseable
            // as JSON and treat any non-block as no-op.
            let parsedAction: unknown;
            try {
              parsedAction = JSON.parse(action);
            } catch {
              parsedAction = { kind: "block" };
            }
            const actionKind =
              parsedAction && typeof parsedAction === "object" && (parsedAction as { kind?: unknown }).kind === "block"
                ? "block"
                : "block"; // v1: default to block
            out.push({
              rule_id: ruleId,
              when: decoded,
              then: { kind: actionKind } as { kind: "block" },
              reason,
            });
          }
          return out;
        }),
    };
  }),
);
