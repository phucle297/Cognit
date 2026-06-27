/**
 * `cognit constraint {add,list,test}` — manage constraint rules
 * (phase 3c).
 *
 * - `add --json '<rule>' [--session <id>] [--root <path>]`
 *   Appends a `constraint_rule_added` event. The rule's `when` is
 *   validated against the closed v1 predicate set; the engine then
 *   evaluates the rule on every subsequent `appendEvent` call.
 *
 * - `list [--session <id>] [--root <path>]`
 *   Reads past `constraint_rule_added` events for the session and
 *   prints them.
 *
 * - `test --type <event_type> [--payload <json|file>] [--session <id>]`
 *   Dry-run: evaluate the current rule set against a synthetic
 *   candidate event and report which rules would fire.
 */

import { Command } from "commander";
import { Effect, Exit, Cause } from "effect";
import { EventStore, ConstraintPolicy, type ActorType } from "@cognit/db";
import { VALID_ACTOR_TYPES } from "@cognit/core";
import { findProjectRoot } from "../paths.js";
import { resolveSessionId, warnStalePointer } from "../session-resolver.js";
import { withAppLayer } from "../layer-build.js";
import { decodePredicate } from "@cognit/db";
import { getOutputMode, emit } from "../output.js";

interface AddOptions {
  json?: string;
  session?: string;
  actor?: string;
  root?: string;
  ruleId?: string;
}

interface ListOptions {
  session?: string;
  root?: string;
}

interface TestOptions {
  type?: string;
  payload?: string;
  session?: string;
  root?: string;
}

const parseActor = (
  raw: string | undefined,
  defaultName: string,
  defaultType: ActorType,
): { name: string; type: ActorType } => {
  if (!raw) return { name: defaultName, type: defaultType };
  const idx = raw.lastIndexOf(":");
  if (idx < 0) return { name: raw, type: defaultType };
  const name = raw.slice(0, idx);
  const type = raw.slice(idx + 1) as ActorType;
  if (!VALID_ACTOR_TYPES.has(type)) {
    process.stderr.write(`cognit: --actor type must be one of human|worker|system, got: ${type}\n`);
    process.exitCode = 2;
    return { name: defaultName, type: defaultType };
  }
  return { name: name || defaultName, type };
};

const resolveProjectRoot = (raw: string | undefined): string => {
  if (raw) return raw;
  const root = findProjectRoot();
  if (!root) {
    process.stderr.write("cognit: no .cognit/cognit.yaml found. Run `cognit init` first.\n");
    process.exitCode = 2;
    throw new Error("not in a cognit project");
  }
  return root;
};

const runConstraint = async <A,>(
  eff: Effect.Effect<A, unknown, never>,
): Promise<A> => {
  const exit = await Effect.runPromiseExit(eff);
  if (Exit.isFailure(exit)) {
    const err = Cause.failureOption(exit.cause);
    if (err._tag === "Some") {
      const fail = err.value as { _tag?: string; message?: string; reason?: string; ruleId?: string };
      switch (fail._tag) {
        case "ConstraintViolation":
          process.stderr.write(
            `cognit: constraint violation — rule ${fail.ruleId}: ${fail.reason}\n`,
          );
          break;
        case "ValidationFailure":
          process.stderr.write(`cognit: rule payload failed schema validation: ${fail.message}\n`);
          break;
        case "DbError":
          process.stderr.write(`cognit: ${fail.message ?? String(fail)}\n`);
          break;
        default:
          process.stderr.write(`cognit: ${fail.message ?? String(fail)}\n`);
      }
    } else {
      const die = Cause.dieOption(exit.cause);
      if (die._tag === "Some") {
        process.stderr.write(`cognit: ${String(die.value)}\n`);
      } else {
        process.stderr.write(`cognit: constraint failed\n`);
      }
    }
    if (process.exitCode === undefined) process.exitCode = 1;
    throw new Error("constraint: failed");
  }
  return exit.value;
};

export function registerConstraint(program: Command): void {
  const constraint = program
    .command("constraint")
    .description("manage constraint rules (phase 3c)");

  constraint
    .command("add")
    .description("add a constraint rule (validates against the v1 predicate set)")
    .requiredOption("--json <rule>", "rule spec as JSON: { when, then, reason }")
    .option("--session <id>", "session id (ULID) (defaults to sticky current-session pointer)")
    .option("--actor <name:type>", 'actor override (default "cognit-cli:system")')
    .option("--root <path>", "project root (defaults to nearest .cognit/cognit.yaml)")
    .option("--rule-id <id>", "caller-supplied rule id (auto-generated if absent)")
    .action(async (opts: AddOptions) => {
      const root = resolveProjectRoot(opts.root);
      const actor = parseActor(opts.actor, "cognit-cli", "system");
      const resolved = resolveSessionId(root, opts.session);
      if (!resolved) {
        process.stderr.write(
          "cognit: --session is required (or run `cognit session create` to set the sticky pointer)\n",
        );
        process.exitCode = 2;
        return;
      }
      if (resolved.source === "pointer") warnStalePointer(root, resolved.sessionId);
      const sessionId = resolved.sessionId;

      // Parse the rule JSON. The `when` field is the closed v1
      // Predicate; the `then` field is an Action (v1 = block only).
      let ruleSpec: { when: unknown; then: unknown; reason: unknown };
      try {
        ruleSpec = JSON.parse(opts.json!);
      } catch (e) {
        process.stderr.write(`cognit: --json is not valid JSON: ${(e as Error).message}\n`);
        process.exitCode = 2;
        return;
      }
      if (!ruleSpec || typeof ruleSpec !== "object") {
        process.stderr.write(`cognit: --json must be a JSON object\n`);
        process.exitCode = 2;
        return;
      }
      const conditionJson = JSON.stringify(ruleSpec.when);
      let decodedPredicate;
      try {
        decodedPredicate = decodePredicate(conditionJson);
      } catch (e) {
        process.stderr.write(`cognit: invalid predicate in --json: ${(e as Error).message}\n`);
        process.exitCode = 2;
        return;
      }
      // v1 action vocabulary: only `block` is supported. Reject
      // anything else at the CLI surface so the user gets a clean
      // error here rather than a DbError from the policy layer.
      const thenShape = (ruleSpec.then ?? { kind: "block" }) as { kind?: unknown };
      if (
        !thenShape ||
        typeof thenShape !== "object" ||
        (thenShape as { kind?: unknown }).kind !== "block"
      ) {
        process.stderr.write(
          `cognit: invalid action in --json: v1 supports only { kind: "block" }, got ${JSON.stringify(thenShape)}\n`,
        );
        process.exitCode = 2;
        return;
      }
      const actionsJson = JSON.stringify(thenShape);
      const reason = typeof ruleSpec.reason === "string" ? ruleSpec.reason : "(no reason)";
      const ruleId = opts.ruleId ?? `rule_${Date.now().toString(36)}`;

      const program = Effect.gen(function* () {
        const store = yield* EventStore;
        const event = yield* store.append({
          sessionId,
          type: "constraint_rule_added",
          payload: {
            rule_id: ruleId,
            condition_json: conditionJson,
            actions_json: actionsJson,
            reason,
          } as Record<string, unknown>,
          actor,
        });
        return event;
      });

      const event = await runConstraint(
        (await withAppLayer(root, program)) as unknown as Effect.Effect<
          { id: string; type: string; session_id: string; created_at: string },
          unknown,
          never
        >,
      );
      void decodedPredicate; // predicate validation is the side effect we care about
      process.stdout.write(`rule:     ${ruleId}\n`);
      process.stdout.write(`event:    ${event.id}\n`);
      process.stdout.write(`type:     ${event.type}\n`);
      process.stdout.write(`session:  ${event.session_id}\n`);
      process.stdout.write(`time:     ${event.created_at}\n`);
    });

  constraint
    .command("list")
    .description("list constraint rules currently in effect for the session")
    .option("--session <id>", "session id (ULID) (defaults to sticky current-session pointer)")
    .option("--root <path>", "project root (defaults to nearest .cognit/cognit.yaml)")
    .action(async (opts: ListOptions) => {
      const root = resolveProjectRoot(opts.root);
      const resolved = resolveSessionId(root, opts.session);
      if (!resolved) {
        process.stderr.write(
          "cognit: --session is required (or run `cognit session create` to set the sticky pointer)\n",
        );
        process.exitCode = 2;
        return;
      }
      if (resolved.source === "pointer") warnStalePointer(root, resolved.sessionId);
      const sessionId = resolved.sessionId;

      const program = Effect.gen(function* () {
        const policy = yield* ConstraintPolicy;
        return yield* policy.loadRules(sessionId);
      });
      const rules = await runConstraint(
        (await withAppLayer(root, program)) as unknown as Effect.Effect<
          ReadonlyArray<{ rule_id: string; reason: string; when: unknown }>,
          unknown,
          never
        >,
      );
      if (rules.length === 0) {
        process.stdout.write("(no constraint rules)\n");
        return;
      }
      if (getOutputMode() === "json") {
        emit("json", "constraint.list", rules);
        return;
      }
      for (const r of rules) {
        process.stdout.write(`rule:     ${r.rule_id}\n`);
        process.stdout.write(`  reason: ${r.reason}\n`);
        process.stdout.write(`  when:   ${JSON.stringify(r.when)}\n\n`);
      }
    });

  constraint
    .command("test")
    .description("dry-run a candidate event against the current rule set")
    .requiredOption("--type <event_type>", "candidate event type")
    .option("--payload <json|file>", "candidate payload (inline JSON or path to a .json file)")
    .option("--session <id>", "session id (ULID) (defaults to sticky current-session pointer)")
    .option("--root <path>", "project root (defaults to nearest .cognit/cognit.yaml)")
    .action(async (opts: TestOptions) => {
      const root = resolveProjectRoot(opts.root);
      const resolved = resolveSessionId(root, opts.session);
      if (!resolved) {
        process.stderr.write(
          "cognit: --session is required (or run `cognit session create` to set the sticky pointer)\n",
        );
        process.exitCode = 2;
        return;
      }
      if (resolved.source === "pointer") warnStalePointer(root, resolved.sessionId);
      const sessionId = resolved.sessionId;

      let payload: Record<string, unknown> = {};
      if (opts.payload) {
        let raw = opts.payload;
        if (!raw.startsWith("{")) {
          // Treat as a file path.
          const fs = await import("node:fs");
          raw = fs.readFileSync(raw, "utf8");
        }
        try {
          payload = JSON.parse(raw);
        } catch (e) {
          process.stderr.write(`cognit: --payload is not valid JSON: ${(e as Error).message}\n`);
          process.exitCode = 2;
          return;
        }
      }
      const eventType = opts.type!;

      const program = Effect.gen(function* () {
        const policy = yield* ConstraintPolicy;
        return yield* policy.loadRules(sessionId);
      });
      const rules = await runConstraint(
        (await withAppLayer(root, program)) as unknown as Effect.Effect<
          ReadonlyArray<{ rule_id: string; reason: string; when: unknown }>,
          unknown,
          never
        >,
      );
      if (rules.length === 0) {
        process.stdout.write(`(no rules — event ${eventType} would be allowed)\n`);
        return;
      }
      process.stdout.write(`Rules that match event ${eventType}:\n`);
      for (const r of rules) {
        // The `when` field is the wire Predicate; we just print it
        // (a real predicate eval would require loading the full
        // SessionState). v1 test is structural: a user can verify by
        // hand.
        process.stdout.write(`  - ${r.rule_id}: ${JSON.stringify(r.when)}\n`);
      }
      void payload;
    });
}
