/**
 * packages/agent/src/loop.ts — supervisor Effect program (C2).
 *
 * One tick = one round-trip: read session state → build prompt →
 * ask the LLM → parse → apply. The whole program is an Effect so
 * the caller controls DI, retries, and concurrency.
 *
 * State loading: we read every event for the session via
 * `EventStore.list`. v0.1 sessions are small (dozens of events);
 * the snapshot+tail optimisation is a follow-up. Reading the full
 * log keeps the loop simple and replay-debuggable: a deterministic
 * input (event list) produces a deterministic output (decision).
 *
 * Parse step: the LLM returns a string. We JSON.parse, then run
 * the result through `decodeAgentDecisionEither`. Failures here
 * surface as `DecisionParseError` with the raw text attached so a
 * human (or the CLI dashboard) can see what the model emitted.
 *
 * Idempotency: the caller passes a `tickId` (ULID); we forward it
 * to `applyDecision` which derives per-action event ids from it.
 * Re-running the same tick is safe.
 *
 * Service dependencies (`EventStore`, `Uuid`, `LlmProvider`) are
 * pulled from the Effect R-channel so callers compose them via
 * `Layer.provide` instead of passing them through input arguments.
 *
 * Note: we use `Effect.gen` (not Effect's try/catch wrapping) so
 * the typed error channel carries the union of every failure mode.
 */

import type { CognitConfig } from "@cognit/core/config";
import { reduce } from "@cognit/core/reducer";
import { emptySessionState, type ReducerEvent, type SessionState } from "@cognit/core/state";
import { EventStore, Uuid } from "@cognit/db";
import { Effect, Schema } from "effect";
import { applyDecision, type ApplyError } from "./apply.js";
import type { AgentConfig } from "./agent-config.js";
import { AgentDecision, decodeAgentDecisionEither } from "./decision.js";
import {
  JsonParseError,
  LlmCompletionError,
  SchemaValidationError,
} from "./errors.js";
import { LlmProvider } from "./llm.js";
import { buildPrompt } from "./prompt.js";

/**
 * Raised when the LLM returns a string that does not decode as an
 * AgentDecision. The raw text is attached for diagnostics.
 */
export class DecisionParseError extends Error {
  override readonly name = "DecisionParseError";
  constructor(
    message: string,
    readonly raw: string,
  ) {
    super(message);
  }
}

/** A single tick's outcome — surfaced to the CLI / dashboard. */
export interface TickResult {
  readonly tickId: string;
  readonly sessionId: string;
  readonly decision: AgentDecision;
  readonly actionsApplied: number;
  readonly rankOverridesApplied: number;
  readonly actionsTruncated: number;
  readonly stop: boolean;
}

/** Input to a tick. Service deps (EventStore/Uuid/LlmProvider) come from the R-channel. */
export interface RunTickInput {
  readonly sessionId: string;
  readonly cfg: CognitConfig;
  readonly agent: AgentConfig;
  readonly actor: { readonly name: string; readonly type: "human" | "worker" | "system" };
  readonly tickId?: string;
  /**
   * Optional abort signal forwarded to the LLM SDK call. Used by the
   * CLI / supervisor to cancel an in-flight tick when its budget
   * expires or the process is shutting down. Optional — leaving it
   * undefined preserves the prior "fire and forget" behaviour.
   */
  readonly signal?: AbortSignal;
}

/** Errors a tick can produce. */
export type TickError =
  | LlmCompletionError
  | JsonParseError
  | SchemaValidationError
  | DecisionParseError
  | ApplyError;

/**
 * Run one supervisor tick. Pure orchestration: read state, prompt,
 * call, parse, apply. No retries — the caller wraps the Effect if
 * it wants at-most-N-attempts semantics.
 */
export const runTick = (
  input: RunTickInput,
): Effect.Effect<TickResult, TickError, EventStore | Uuid | LlmProvider> =>
  Effect.gen(function* () {
    const store = yield* EventStore;
    const uuid = yield* Uuid;
    const llm = yield* LlmProvider;

    const tickId = input.tickId ?? (yield* uuid.make());
    const sessionId = input.sessionId;

    // 1. Read all events for the session, fold into SessionState.
    const listed = yield* store.list({ sessionId, limit: 1000 });
    const initial = emptySessionState({
      session_id: sessionId,
      project_id: "",
      goal: "",
    });
    // The reducer is total; if a malformed event slips past the
    // migration step, the reducer ignores it rather than throwing
    // (see @cognit/core/reducer.ts). We do not wrap in try/catch.
    const state: SessionState = reduce(listed.events as ReadonlyArray<ReducerEvent>, initial);

    // 2. Build prompt (pure).
    const prompt = buildPrompt(state, input.cfg, input.agent);

    // 3. Call the LLM. Prefer the typed JSON-completion path
    //    (`completeJson`) when the provider exposes it — C1's
    //    `@cognit/llm` Layer does, the test mock does not. Falling
    //    back to raw `complete()` + manual parse keeps the loop
    //    honest with the test layer used in C2 unit tests.
    //
    //    The optional `input.signal` is forwarded so the supervisor
    //    can cancel an in-flight LLM call when its tick budget
    //    expires or the CLI is shutting down. We conditionally
    //    include the field so it is not passed when undefined
    //    (`exactOptionalPropertyTypes: true`).
    let decision: AgentDecision;
    if (llm.completeJson) {
      decision = (yield* llm.completeJson({
        prompt,
        model: input.agent.model,
        schema: AgentDecision as Schema.Schema<AgentDecision>,
        ...(input.signal ? { signal: input.signal } : {}),
      })) as AgentDecision;
    } else {
      const raw = yield* llm.complete({
        prompt,
        model: input.agent.model,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(raw);
      } catch (e) {
        return yield* Effect.fail(
          new DecisionParseError(
            `agent tick: LLM output is not valid JSON: ${(e as Error).message}`,
            raw,
          ),
        );
      }
      const decoded = decodeAgentDecisionEither(parsedJson);
      if (decoded._tag === "Left") {
        return yield* Effect.fail(
          new DecisionParseError(
            `agent tick: LLM output failed AgentDecision validation: ${String(decoded.left)}`,
            raw,
          ),
        );
      }
      decision = decoded.right;
    }

    // 5. Apply.
    const applied = yield* applyDecision({
      store,
      decision,
      tickId,
      sessionId,
      actor: input.actor,
      cfg: input.agent,
    });

    return {
      tickId,
      sessionId,
      decision,
      actionsApplied: applied.actions.length,
      rankOverridesApplied: applied.rankOverrides.length,
      actionsTruncated: applied.actionsTruncated,
      stop: decision.stop,
    };
  });
