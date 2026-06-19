/**
 * apps/server/src/routes/rules.ts — phase 8 (8g.5) project-wide
 * constraint rules CRUD endpoint surface used by the dashboard's
 * /rules page.
 *
 * Endpoints:
 *   GET    /api/rules                        list (collapses re-emits by rule_id)
 *   POST   /api/rules                        add → emits constraint_rule_added
 *   PATCH  /api/rules/:id                    toggle enabled flag (re-emits)
 *   DELETE /api/rules/:id                    soft delete (re-emits with enabled:false + deleted:true)
 *
 * Rules are session-scoped under the hood (the existing
 * `constraint_rule_added` event carries `session_id`). The dashboard
 * surface is project-wide: we list every rule across every active
 * session in the project so the operator sees one collapsed view.
 * The `session_id` query param scopes mutations; without it we use
 * the most-recently-active session.
 *
 * Storage source:
 *   - `db`:   rule originates from a `constraint_rule_added` event
 *   - `yaml`: rule originates from `cognit.yaml` (read-only, future)
 *
 * The current implementation surfaces only `db`-sourced rules — YAML
 * loading happens in `apps/cli` when the project boots. The route
 * still emits the `source` field so the UI can render the badge and
 * the YAML loader can be wired in a follow-up without breaking the
 * wire shape.
 *
 * Read-only invariant: GET never appends events; PATCH/DELETE/POST
 * append exactly one event per request.
 */
import { Effect } from "effect";
import { Hono } from "hono";
import {
  EventStore,
  SessionService,
  decodePredicate,
  type EventRow,
  type SessionRow,
} from "@cognit/db";
import { envelope } from "../envelope.js";
import { apiErrorResponse } from "../api-error.js";
import type { SessionsRouteDeps } from "./sessions.js";

interface RuleWire {
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

/** Parse a `constraint_rule_added` event payload to a `RuleWire`. */
const parseRuleEvent = (
  ev: EventRow,
  sessionId: string,
): RuleWire | null => {
  let p: Record<string, unknown>;
  try {
    const parsed = JSON.parse(ev.payload_json);
    if (!parsed || typeof parsed !== "object") return null;
    p = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const rule_id = typeof p["rule_id"] === "string" ? (p["rule_id"] as string) : ev.id;
  const conditionJson =
    typeof p["condition_json"] === "string" ? (p["condition_json"] as string) : null;
  const actionJson =
    typeof p["actions_json"] === "string" ? (p["actions_json"] as string) : null;
  if (!conditionJson || !actionJson) return null;
  let condition: unknown;
  let action: unknown;
  try {
    condition = JSON.parse(conditionJson);
    action = JSON.parse(actionJson);
  } catch {
    return null;
  }
  return {
    id: rule_id,
    session_id: sessionId,
    condition,
    action,
    reason: typeof p["reason"] === "string" ? (p["reason"] as string) : "(no reason)",
    // `enabled` defaults to true unless the latest re-emit explicitly
    // disabled the rule. We collapse multiple emits by rule_id below.
    enabled: p["enabled"] === false ? false : true,
    deleted: p["deleted"] === true,
    source: "db",
    created_at: ev.created_at,
    updated_at: ev.created_at,
  };
};

/**
 * Collapse a list of `constraint_rule_added` events into one
 * `RuleWire` per `rule_id`. Later emits override earlier ones; the
 * `created_at` is the first emit (so the UI shows when the rule
 * first appeared) and `updated_at` is the most-recent emit.
 */
const collapseRules = (
  events: ReadonlyArray<{ ev: EventRow; sessionId: string }>,
): ReadonlyArray<RuleWire> => {
  const byId = new Map<string, RuleWire>();
  for (const { ev, sessionId } of events) {
    const parsed = parseRuleEvent(ev, sessionId);
    if (!parsed) continue;
    const prior = byId.get(parsed.id);
    if (prior) {
      // Re-emit: keep the original `created_at`, take everything
      // else from the latest event.
      byId.set(parsed.id, {
        ...parsed,
        created_at: prior.created_at,
        updated_at: parsed.updated_at,
      });
    } else {
      byId.set(parsed.id, parsed);
    }
  }
  // Hide soft-deleted rules from the surface.
  return Array.from(byId.values()).filter((r) => !r.deleted);
};

const generateRuleId = (): string =>
  `rule_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;

/**
 * Pick the session id to operate against. Caller can pin via
 * `session_id` body field or `?session_id=` query; otherwise we use
 * the most-recently-active session in the project.
 */
const resolveSessionForMutation = (
  sessions: ReadonlyArray<SessionRow>,
  explicit: string | null,
): string | null => {
  if (explicit) {
    const hit = sessions.find((s) => s.id === explicit);
    return hit ? hit.id : null;
  }
  const active = sessions
    .filter((s) => s.status === "active")
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  if (active.length > 0) return active[0]!.id;
  return null;
};

export const registerRulesRoutes = (app: Hono, deps: SessionsRouteDeps): void => {
  const { runtime, projectId } = deps;

  // GET /api/rules
  app.get("/api/rules", async (c) => {
    const sessionFilter = c.req.query("session_id") ?? null;
    const program = Effect.gen(function* () {
      const service = yield* SessionService;
      const store = yield* EventStore;
      const sessions = yield* service.list({ projectId });
      const target = sessionFilter
        ? sessions.filter((s) => s.id === sessionFilter)
        : sessions;
      const collected: Array<{ ev: EventRow; sessionId: string }> = [];
      for (const s of target) {
        const page = yield* store.list({ sessionId: s.id, type: "constraint_rule_added" });
        for (const ev of page.events) collected.push({ ev, sessionId: s.id });
      }
      return collapseRules(collected);
    });
    const exit = await runtime.runPromiseExit(
      program as Effect.Effect<unknown, unknown, never>,
    );
    if (exit._tag === "Failure") {
      return apiErrorResponse(c, "internal", "rules.list: query failed");
    }
    const rules = (exit as { value: ReadonlyArray<RuleWire> }).value;
    return c.json(envelope("rules.list", { rules }));
  });

  // POST /api/rules
  app.post("/api/rules", async (c) => {
    let body: Record<string, unknown> = {};
    try {
      const text = await c.req.text();
      if (text.length > 0) {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === "object") body = parsed as Record<string, unknown>;
      }
    } catch {
      return apiErrorResponse(c, "bad_request", "rules.add: body is not valid JSON");
    }
    const condition = body["when"] ?? body["condition"];
    const thenShape = body["then"] ?? body["action"] ?? { kind: "block" };
    const reason = typeof body["reason"] === "string" ? (body["reason"] as string) : "(no reason)";
    const requestedSession = typeof body["session_id"] === "string" ? (body["session_id"] as string) : null;
    const requestedId = typeof body["rule_id"] === "string" ? (body["rule_id"] as string) : null;

    if (!condition || typeof condition !== "object") {
      return apiErrorResponse(c, "validation_failed", "rules.add: `when` must be an object");
    }
    const conditionJson = JSON.stringify(condition);
    try {
      decodePredicate(conditionJson);
    } catch (e) {
      return apiErrorResponse(
        c,
        "validation_failed",
        `rules.add: invalid predicate: ${(e as Error).message}`,
      );
    }
    if (!thenShape || typeof thenShape !== "object") {
      return apiErrorResponse(c, "validation_failed", "rules.add: `then` must be an object");
    }
    const actionsJson = JSON.stringify(thenShape);
    const ruleId = requestedId ?? generateRuleId();

    const program = Effect.gen(function* () {
      const service = yield* SessionService;
      const store = yield* EventStore;
      const sessions = yield* service.list({ projectId });
      const sid = resolveSessionForMutation(sessions, requestedSession);
      if (!sid) return { kind: "no_session" as const };
      const ev = yield* store.append({
        sessionId: sid,
        type: "constraint_rule_added",
        payload: {
          rule_id: ruleId,
          condition_json: conditionJson,
          actions_json: actionsJson,
          reason,
          enabled: true,
          deleted: false,
        } as Record<string, unknown>,
        actor: { name: "dashboard", type: "system" },
      });
      return { kind: "ok" as const, event: ev, sid };
    });
    const exit = await runtime.runPromiseExit(
      program as Effect.Effect<unknown, unknown, never>,
    );
    if (exit._tag === "Failure") {
      return apiErrorResponse(c, "internal", "rules.add: append failed");
    }
    const v = (exit as {
      value:
        | { kind: "no_session" }
        | { kind: "ok"; event: EventRow; sid: string };
    }).value;
    if (v.kind === "no_session") {
      return apiErrorResponse(c, "validation_failed", "rules.add: no active session in project");
    }
    return c.json(
      envelope("rules.add", {
        rule: {
          id: ruleId,
          session_id: v.sid,
          condition,
          action: thenShape,
          reason,
          enabled: true,
          deleted: false,
          source: "db",
          created_at: v.event.created_at,
          updated_at: v.event.created_at,
        } satisfies RuleWire,
      }),
      201,
    );
  });

  // PATCH /api/rules/:id — toggle enabled.
  // Body: { enabled: boolean }
  app.patch("/api/rules/:id", async (c) => {
    const ruleId = c.req.param("id");
    let body: Record<string, unknown> = {};
    try {
      const text = await c.req.text();
      if (text.length > 0) {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === "object") body = parsed as Record<string, unknown>;
      }
    } catch {
      return apiErrorResponse(c, "bad_request", "rules.patch: body is not valid JSON");
    }
    const nextEnabled = body["enabled"] === false ? false : true;
    const program = Effect.gen(function* () {
      const service = yield* SessionService;
      const store = yield* EventStore;
      const sessions = yield* service.list({ projectId });
      // Find the most-recent emit for this rule_id.
      const collected: Array<{ ev: EventRow; sessionId: string }> = [];
      for (const s of sessions) {
        const page = yield* store.list({ sessionId: s.id, type: "constraint_rule_added" });
        for (const ev of page.events) collected.push({ ev, sessionId: s.id });
      }
      const all = collapseRules(collected);
      const target = all.find((r) => r.id === ruleId);
      if (!target) return { kind: "not_found" as const };
      const ev = yield* store.append({
        sessionId: target.session_id,
        type: "constraint_rule_added",
        payload: {
          rule_id: target.id,
          condition_json: JSON.stringify(target.condition),
          actions_json: JSON.stringify(target.action),
          reason: target.reason,
          enabled: nextEnabled,
          deleted: target.deleted,
        } as Record<string, unknown>,
        actor: { name: "dashboard", type: "system" },
      });
      return { kind: "ok" as const, event: ev, target, nextEnabled };
    });
    const exit = await runtime.runPromiseExit(
      program as Effect.Effect<unknown, unknown, never>,
    );
    if (exit._tag === "Failure") {
      return apiErrorResponse(c, "internal", "rules.patch: append failed");
    }
    const v = (exit as {
      value:
        | { kind: "not_found" }
        | { kind: "ok"; event: EventRow; target: RuleWire; nextEnabled: boolean };
    }).value;
    if (v.kind === "not_found") {
      return apiErrorResponse(c, "not_found", `rule '${ruleId}' not found`);
    }
    return c.json(
      envelope("rules.patch", {
        rule: {
          ...v.target,
          enabled: v.nextEnabled,
          updated_at: v.event.created_at,
        } satisfies RuleWire,
      }),
    );
  });

  // DELETE /api/rules/:id — soft-delete (re-emit with `deleted:true`).
  app.delete("/api/rules/:id", async (c) => {
    const ruleId = c.req.param("id");
    const program = Effect.gen(function* () {
      const service = yield* SessionService;
      const store = yield* EventStore;
      const sessions = yield* service.list({ projectId });
      const collected: Array<{ ev: EventRow; sessionId: string }> = [];
      for (const s of sessions) {
        const page = yield* store.list({ sessionId: s.id, type: "constraint_rule_added" });
        for (const ev of page.events) collected.push({ ev, sessionId: s.id });
      }
      const all = collapseRules(collected);
      const target = all.find((r) => r.id === ruleId);
      if (!target) return { kind: "not_found" as const };
      const ev = yield* store.append({
        sessionId: target.session_id,
        type: "constraint_rule_added",
        payload: {
          rule_id: target.id,
          condition_json: JSON.stringify(target.condition),
          actions_json: JSON.stringify(target.action),
          reason: target.reason,
          enabled: false,
          deleted: true,
        } as Record<string, unknown>,
        actor: { name: "dashboard", type: "system" },
      });
      return { kind: "ok" as const, event: ev };
    });
    const exit = await runtime.runPromiseExit(
      program as Effect.Effect<unknown, unknown, never>,
    );
    if (exit._tag === "Failure") {
      return apiErrorResponse(c, "internal", "rules.delete: append failed");
    }
    const v = (exit as {
      value: { kind: "not_found" } | { kind: "ok"; event: EventRow };
    }).value;
    if (v.kind === "not_found") {
      return apiErrorResponse(c, "not_found", `rule '${ruleId}' not found`);
    }
    return c.json(envelope("rules.delete", { id: ruleId }));
  });
};
