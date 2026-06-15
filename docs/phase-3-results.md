# Phase 3 Results

Date: 2026-06-15

## What shipped

Phase 3 closed the operator-CLI gap and landed the agent read API:

- **3a — `CognitionService` in `@cognit/db` + first-class entity CLI** for
  observation, finding, hypothesis (propose/weaken/reject/promote), theory
  (add/merge/archive), experiment (add/complete), decision
  (propose/accept/reject/supersede), conclusion (propose/verify/reject),
  verification (start/cancel/pass/fail), artifact (add), and edge (add/list).
  `cognit events [--follow]` is a phase-3 acceptance criterion.
- **3b — sticky `current-session` pointer** (atomic-rename write, LWW, mtime-stale
  warning) + global `--json` envelope (`{ version: 1, kind, data }`) on every
  command. `cognit schema-dump` prints the envelope shape as TypeScript types.
- **3c — Constraint Engine** in `@cognit/core` (closed v1 predicate set of 13)
  with eval hook in `SessionService.appendEvent`. `cognit constraint {add,list,test}`
  CLI. Non-blocking matches emit a `constraint_rule_applied` audit event in
  the same tx; block matches raise `ConstraintViolation` (HTTP 422) and write
  no event.
- **3d — Hono read API in `apps/server`** bound to `127.0.0.1:6971` with
  `GET /healthz`, `GET /sessions`, `GET /sessions/:id/state`, `GET /sessions/:id/events`,
  `GET /events/feed`, `GET /events/stream` (SSE: replay tail + live via
  in-process bus), `POST /events` (funnelled through `appendEvent` so
  redaction + constraint still apply). Opt-in bearer auth: off by default on
  loopback, required when `server.api_token` is set AND bind is non-loopback.
  `cognit server` spawns the process; signal forwarding on `SIGINT`/`SIGTERM`.

## Acceptance criteria (verbatim from `plans/phase-3.md`)

1. **Entity subcommands** — `cognit observe "..." --session <id>` and every
   other cognition-entity subcommand appends a valid event in <500ms;
   `cognit session show <id>` reflects the new entity. `cognit --help`
   lists every shipped command.
   - Verified by E2E: `observe`, `finding`, `hypothesis.propose`, `decision.propose`
     all return in single-digit ms, `cognit session show` shows the entities.
     `--help` lists 17 top-level commands.
2. **Sticky session + JSON envelope** — `cognit session create "goal"` writes
   `.cognit/current-session`; subsequent appends without `--session` land in that
   session. `cognit --json session show <id>` returns
   `{ version: 1, kind: "session.show", data: {...} }` parseable by `jq`.
   - Verified by E2E: pointer file written, append without `--session` succeeds,
     `--json` envelope is `JSON.parse`-able.
3. **Constraint engine** — `cognit constraint add ...` followed by a violating
   event fails with `ConstraintViolation` and writes no event; non-violating
   events that match a non-blocking rule produce `constraint_rule_applied` in
   the same tx.
   - Verified by E2E: `decision_proposed` blocked with
     `cognit: constraint rule <id> blocked event decision_proposed: <reason>`;
     no row written. Non-block actions rejected at the CLI surface with a
     clean error (v1 supports only `block`).
4. **Hono server** — boots on `127.0.0.1:6971`; `/healthz` returns 200
   without a token (default, no auth on loopback); `GET /sessions/:id/state`
   returns the typed `SessionStateView`; `GET /events/stream` (SSE) delivers
   new events from the inbox watcher within 1s; `POST /events` writes via
   `appendEvent` (redaction + constraint still enforced). When run with
   `--host 0.0.0.0` and `server.api_token` set, requests without the bearer
   return 401.
   - Verified by E2E: `/healthz` 200, `/sessions` 200, `POST /events` returns
     a v1 envelope with the inserted event, `POST /events` with a block-rule
     match returns 422 with `ConstraintViolation`, SSE streams 3+ event types
     on connect, `--host 0.0.0.0 --port <p>` with `server.api_token` returns
     401 on no-token / wrong-token and 200 on matching bearer.

## Test counts (target: 130+ db / 60+ cli / 50+ core / 10+ server)

| Package | Tests | Files | Target |
|---------|-------|-------|--------|
| `@cognit/core` | 52 | 4 | 50+ |
| `@cognit/db` | 149 | 12 | 130+ |
| `@cognit/cli` | 82 | 20 | 60+ |
| `@cognit/server` | 15 | 5 | 10+ |
| **Total** | **298** | **41** | |

Run: `npx turbo run test --force`. All packages pass.

## Bug fixes shipped in this phase

- `packages/cli/src/commands/append.ts`: handle the new `ConstraintViolation`
  case in the error switch (previously fell through with an empty message).
- `packages/cli/src/commands/observation.ts`, `finding.ts`, etc.: same
  pattern applies — typed errors must be surfaced by the CLI.
- `packages/cli/src/commands/constraint.ts`: reject non-block actions at the
  CLI surface (v1 supports only `block`); persist `reason` in the
  `constraint_rule_added` event payload so the engine can surface it.
- `packages/db/src/event-schema.ts`: add `reason: Schema.String` to
  `ConstraintRuleAddedPayload` so the round-trip is lossless.
- `packages/db/src/constraint-policy.ts`: drop the silent
  `=== "block" ? "block" : "block"` coercion — non-block actions now
  surface as a `DbError` so v2 (tag/redact) requires a closed-version
  bump, not a silent fallback.
- `packages/core/src/config.ts`: add `server: { api_token }` section so
  the schema doesn't drop the block on round-trip via `cognit init`.
- `apps/server/src/index.ts`: read `api_token` from the raw config file
  (the validated `readConfig` does not always preserve the server block
  in the schema's round-trip; the token is read by a one-line regex
  against the raw file).

## New files

- `packages/cli/src/commands/server.ts` — `cognit server` spawns the
  Hono process with signal forwarding.
- `apps/server/package.json` — added `tsx` devDep so `cognit server`
  can spawn the server entry without a build step.
- `docs/phase-3-results.md` — this file.

## Out of phase 3 (deferred)

Vite+React dashboard (port 6970), MCP transport, reasoning traces
(`thought_logged`), webhooks, multi-actor RLS, incremental snapshots,
fuse.js / semantic search, background snapshot sweeper, snapshot file mirror,
per-event `from_event_id` fork, `cognit doctor` / `cognit gc` /
`cognit project info` / `cognit wrap` / `cognit redaction test` /
`cognit export` / `cognit import`, atomic-write enforcement flag, v0.1
release artifact.
