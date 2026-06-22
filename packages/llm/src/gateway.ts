/**
 * packages/llm/src/gateway.ts — Vercel AI Gateway model factory.
 *
 * New default transport for `cognit ask` and (after migration) the
 * supervisor loop. Replaces the closed-literal `modelFor(provider,
 * modelId)` switch with a single Gateway-routed call.
 *
 * Why a separate module:
 *   1. The Gateway SDK uses a different factory surface
 *      (`gateway(modelId)` from `@ai-sdk/gateway`) than the direct
 *      provider SDKs. Keeping the factory in its own module means
 *      `layer.ts` doesn't import five different SDKs.
 *   2. Per-model API key overrides live in `LlmConfig` (`@cognit/core`).
 *      Resolution belongs near the factory that consumes it.
 *   3. Tests can mock `gatewayModelFor` cleanly without touching the
 *      retry / abort logic in `layer.ts`.
 *
 * Resolution rule (spec §2):
 *   1. `llm.models[<model>].api_key_env` if present
 *   2. else `llm.api_key_env`
 *   Read env. If missing → `LlmCompletionError` with the exact env
 *   var name in the message. No silent fallback.
 *
 * Back-compat:
 *   `provider.ts` still exists for the legacy `--provider anthropic`
 *   path during the grace period. After removal, that module is
 *   deleted entirely.
 */

import { createGateway, type GatewayModelId } from "@ai-sdk/gateway";
import type { LlmConfig } from "@cognit/core";
import { LlmCompletionError } from "./errors.js";

/**
 * Resolved Gateway route: env var to read for the API key + the
 * full Gateway model id (e.g. `MiniMax/MiniMax-M3`).
 *
 * Pre-resolved (not lazy) so `LlmLive` / `LlmLiveLazy` can fail at
 * build time when the env is missing, exactly like the legacy
 * `assertEnvFor` boot check.
 */
export interface GatewayRoute {
  apiKeyEnv: string;
  modelId: string;
}

/**
 * Resolve the Gateway route for a given model. The `apiKeyEnv` is
 * the env var name to read at call time — NOT the key value. The
 * factory reads `process.env[route.apiKeyEnv]` on every call so a
 * key rotated mid-process is picked up without restart.
 *
 * @param llm — the `llm:` block from `cognit.yaml`. Must be present
 *   (the schema defaults it; callers that pass a partial config
 *   should fill in defaults upstream).
 * @param modelId — the resolved Gateway model string.
 */
export const resolveGatewayRoute = (llm: LlmConfig, modelId: string): GatewayRoute => {
  const override = llm.models[modelId];
  const apiKeyEnv = override?.api_key_env ?? llm.api_key_env;
  if (!apiKeyEnv) {
    // Schema should make this unreachable; defend against runtime
    // callers that build an LlmConfig by hand.
    throw new LlmCompletionError(
      `gateway route: no api_key_env resolved for model ${modelId} (set llm.api_key_env or llm.models.${modelId}.api_key_env)`,
    );
  }
  return { apiKeyEnv, modelId };
};

/**
 * Build a `LanguageModelV3` for the given route. Reads the API key
 * from `process.env[route.apiKeyEnv]` on every call (so env changes
 * are picked up). Throws `LlmCompletionError` synchronously when the
 * env is missing — call sites wrap this in `Effect.try` or layer
 * factories that defer to first use.
 *
 * The Gateway SDK is created per call because its `apiKey` setting
 * is captured at construction; reusing one `createGateway` across
 * different keys would require key rotation through the SDK, which
 * it does not currently expose. Per-call construction is cheap (a
 * single object literal) and makes the rotation story trivial.
 */
export const gatewayModelFor = (route: GatewayRoute) => {
  const raw = process.env[route.apiKeyEnv];
  const apiKey = typeof raw === "string" ? raw.trim() : "";
  if (apiKey === "") {
    throw new LlmCompletionError(
      `required env ${route.apiKeyEnv} not set (model ${route.modelId}, source: gateway route)`,
    );
  }
  const gw = createGateway({ apiKey });
  // GatewayModelId is a literal union with `(string & {})` escape
  // hatch; new models land before the type is regenerated. Cast is
  // safe — the Gateway itself rejects unknown ids at request time.
  return gw(route.modelId as GatewayModelId);
};

/**
 * Build a model from an `LlmConfig` + model id in one step. Shorthand
 * for `gatewayModelFor(resolveGatewayRoute(llm, modelId))` used by
 * the layer builder and the `cognit ask` command.
 */
export const gatewayModel = (llm: LlmConfig, modelId: string) =>
  gatewayModelFor(resolveGatewayRoute(llm, modelId));