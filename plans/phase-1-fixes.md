# Phase 1 Fix Plan

## Context

A 5-agent audit of `packages/db/` (subtasks Cognit-ibg through Cognit-udo) found:

- **3 P0 bugs** that prevent phase 1 from working in production (filed as `Cognit-2k5`, `Cognit-ezs`, `Cognit-7hw`).
- **8 P1 gaps** that violate the plan, leak Effect error semantics, or leave the schema/types incomplete (filed as `Cognit-nl1`, `Cognit-cpz`, `Cognit-ppf`, `Cognit-825`, `Cognit-44u`, `Cognit-muu`, `Cognit-eeg`, `Cognit-xtb`).
- **2 P2 cleanup items** (test coverage, `nowIso` called twice per append, `filePath` → `file_path` rename).

Tests still pass (30/30) and `tsc --noEmit` is clean, because the bugs are runtime / contract issues that the existing tests don't cover. This plan fixes all of them, restores plan adherence, and adds the missing test surface.

## Goal

After this plan executes:

- `pnpm -F @cognit/db test` passes 30+ → 40+ tests.
- `pnpm -r exec tsc --noEmit` clean.
- `plans/phase-1.md` and `plan.xml` reflect what the code actually does (no drift).
- A manual smoke (run watcher, drop `.json` files, assert rows appear) passes.
- All 3 P0 bugs closed; all 8 P1 gaps closed.

## Out of scope

- CLI wire (`Cognit-mej`) — phase 1 close gate is DB-side.
- Inbox adapter dedup vs `Cognit-2ie` — overlap with Fix A; we will reuse the bead, not duplicate.
- Docs update (`Cognit-3fh`) — separate task, will update `plan.xml` here as part of the spec-amendment decisions below, but the STACK.md / CONVENTIONS.md update is its own bead.

## Open decisions (need user input before execution)

These three choices change the shape of the fixes. I'll default each one and proceed unless the user redirects.

### D1. How to thread the path through `scanValue` for `redactEvent` (Fix B)

Two options, both close the audit gap:

- **D1.a (default)** — change `redactEvent` to call `scanValue({ value: payload }, "value")`, so every hit gets a non-empty `fieldPath` (e.g. `value.text`, `value[0]`). The filter in `event-store.ts:234` then works as intended.
- **D1.b** — keep `redactEvent` as-is, but change `scanValue` to set the root path to the event type string when called from `redactEvent`. Requires a new parameter on `scanValue` or a separate `scanValueWithRoot(value, rootPath)` helper.

**Default: D1.a.** Less API change, single-line edit.

### D2. `EventValidator` Tag: delete or fix (Fix D / `Cognit-825`)

- **D2.a (default)** — delete the `EventValidator` Tag, its `Live` layer, the `leafs` entry in `live.ts`, the re-export in `index.ts`, and the plan.xml row. Code that inlines `Schema.decodeUnknownEither` (in `event-store.ts` and `migrate.ts`) stays as-is.
- **D2.b** — fix `validate` to return `Either<ParseError, unknown>` (or `Option<unknown>`), and rewire `appendEvent` and `migratePayload` to `yield* EventValidator` instead of inlining the schema lookup.

**Default: D2.a.** The inline lookup is two lines; the indirection through a Tag doesn't pay for itself. Spec is the source of truth, not the Tag list.

### D3. `appendEvent` order: revert to plan or amend plan (Fix D / `Cognit-xtb`)

- **D3.a** — keep current impl order (type known → validate → idempotency → session → tx{ensureActor → redact → insert event → redaction_applied → return}), which gives stronger atomicity. Amend `plan.xml` and `plans/phase-1.md` to match.
- **D3.b** — revert to plan order exactly (ensureActor outside tx, redaction_applied emitted before main event). Atomicity is weaker (the actor autoreg can succeed but the main insert can fail; the redaction_applied events would already be committed).

**Default: D3.a.** Atomicity wins. Plan is amended.

---

## Priority / order of execution

The fixes are bundled into 4 cycles. Each cycle = one agent + one quality gate. Cycles run sequentially; P0 first, then P1 schema/row/FK, then P1 event-store correctness, then cleanup.

| Cycle | Fixes                                                | Beads                                                                                                  | Files touched                                                                                                                                                                           | Cycle scope |
| ----- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| **1** | P0-1 inbox fiber R-channel                           | `Cognit-2k5`                                                                                           | `packages/db/src/inbox.ts`, `packages/db/test/inbox.test.ts`                                                                                                                            | small       |
| **2** | P0-3 migration runner + P1-5 rows.ts + P1-6 FK       | `Cognit-7hw`, `Cognit-44u`, `Cognit-muu`                                                               | `packages/db/src/schema/migrations.ts` (NEW), `packages/db/src/schema/rows.ts`, `packages/db/src/schema/tables.ts`, `packages/db/src/connection.ts`, `packages/db/test/migrate.test.ts` | medium      |
| **3** | P0-2 redaction audit gap                             | `Cognit-ezs`                                                                                           | `packages/db/src/redaction.ts`, `packages/db/src/event-store.ts`, `packages/db/test/redaction.test.ts`, `packages/db/test/event-store.test.ts`                                          | medium      |
| **4** | P1 event-store correctness + inbox P1 + cleanup + P2 | `Cognit-nl1`, `Cognit-cpz`, `Cognit-ppf`, `Cognit-825`, `Cognit-eeg`, `Cognit-xtb`, and the 2 P2 items | `packages/db/src/event-store.ts`, `packages/db/src/inbox.ts`, `packages/db/src/event-schema.ts`, `packages/db/src/layers/live.ts`, `packages/db/src/index.ts`, all test files           | large       |

Cycle 1 must run first (inbox is dead in prod). Cycle 2 and 3 are independent of each other (touches different files) and can run in parallel. Cycle 4 depends on 1, 2, 3 being merged.

After all four cycles: update `plans/phase-1.md` and `plan.xml` to reflect the actual implementation per decisions D1.a, D2.a, D3.a. Close `Cognit-3fh` docs bead.

---

## Cycle 1 — Inbox fiber R-channel (P0-1, `Cognit-2k5`)

### Problem

`inbox.ts:179` runs the per-file effect via `Effect.runFork(processFile(filePath) as Effect.Effect<void, never, never>)`. The cast strips `EventStore | Logger` from the R-channel, so the forked fiber dies with `MissingServiceError` the first time it tries to `yield* store.append(...)` or `yield* logger.log(...)`. Chokidar swallows the fiber death, so the operator sees nothing. **Production-breaking: the inbox watcher cannot append any events.**

### Files

- `packages/db/src/inbox.ts`
- `packages/db/test/inbox.test.ts` (add: real-runtime smoke test)

### Change

1. Refactor `runInboxWatcher` to build a `ManagedRuntime` from the caller's R-channel:

   ```ts
   export const runInboxWatcher = (
     config: InboxWatcherConfig,
   ): Effect.Effect<{ stop: () => Promise<void> }, never, EventStore | Logger> =>
     Effect.gen(function* () {
       const { processFile } = yield* makeInboxWatcher(config);
       const runtime = yield* Effect.runtime<EventStore | Logger>();
       const watcher = chokidar.watch(...);
       watcher.on("add", (filePath) => {
         if (!filePath.endsWith(".json")) return;
         runtime.runFork(processFile(filePath));
       });
       return { stop: () => watcher.close() };
     });
   ```

   - `Effect.runtime<R>()` materialises the current fiber's environment into a `Runtime` (Effect 3.10+).
   - `runtime.runFork(effect)` runs the effect on a fiber with that R baked in.
   - This removes the unsafe `as Effect<...>` cast.

2. Update `makeInboxWatcher` docstring to reflect that callers must provide `EventStore | Logger` to `runInboxWatcher`.

### Verification

- Add `test/inbox.test.ts` case: spin up the live test layer (existing `makeTestLayer`), call `runInboxWatcher({ inboxDir, processedDir, errorDir, debounceMs: 50 })`, write a valid `.json` file into `inboxDir`, wait for the file to move to `processedDir`, then assert the event is in the DB and a `redaction_applied` event exists if the payload contained a secret.
- Existing 3 inbox tests (valid file → processed, invalid JSON → error dir, missing fields → error dir) must still pass.

### Done criteria

- `pnpm -F @cognit/db test` shows the new test passing.
- No `as Effect<...>` cast remains in `inbox.ts`.

---

## Cycle 2 — Migration runner + rows + FK (P0-3, P1-5, P1-6)

### Beads

- `Cognit-7hw` (P0-3): migration runner
- `Cognit-44u` (P1-5): rows.ts incomplete
- `Cognit-muu` (P1-6): missing FK on `linked_hypothesis_id`

### Files

- `packages/db/src/schema/migrations.ts` (NEW)
- `packages/db/src/schema/rows.ts` (extend)
- `packages/db/src/schema/tables.ts` (add `hypotheses` stub, add FK on `events.linked_hypothesis_id`)
- `packages/db/src/connection.ts` (call `applyMigrations` instead of iterating `TABLES_DDL`)
- `packages/db/test/migrate.test.ts` (new tests for the runner)

### Change

1. **New `schema/migrations.ts`**:

   ```ts
   export interface Migration {
     readonly version: string;
     readonly up: (db: SqliteHandle) => Effect.Effect<void, DbError>;
   }

   const MIGRATIONS: ReadonlyArray<Migration> = [
     {
       version: "1.0.0",
       up: (db) =>
         Effect.sync(() => {
           for (const ddl of TABLES_DDL) db.exec(ddl);
         }),
     },
   ];

   export const applyMigrations = (
     db: SqliteHandle,
   ): Effect.Effect<{ applied: ReadonlyArray<string> }, DbError> =>
     Effect.gen(function* () {
       // Ensure schema_version table exists (idempotent — first migration creates it via DDL).
       const current = db.get<{ version: string }>(
         "SELECT version FROM schema_version WHERE id = 1",
       );
       const currentVersion = current?.version ?? "0.0.0";
       const applied: string[] = [];
       for (const m of MIGRATIONS) {
         if (semverGte(currentVersion, m.version)) continue;
         yield* Effect.try({
           try: () => db.exec("BEGIN"),
           catch: (e) => new DbError({ message: "begin failed", cause: e }),
         });
         const upResult = yield* m
           .up(db)
           .pipe(Effect.tapError(() => Effect.sync(() => db.exec("ROLLBACK"))));
         yield* Effect.try({
           try: () => db.exec("COMMIT"),
           catch: (e) => new DbError({ message: "commit failed", cause: e }),
         });
         // upsert version
         if (current) {
           db.run("UPDATE schema_version SET version = ?, applied_at = ? WHERE id = 1", [
             m.version,
             nowIso(),
           ]);
         } else {
           db.run("INSERT INTO schema_version (id, version, applied_at) VALUES (1, ?, ?)", [
             m.version,
             nowIso(),
           ]);
         }
         applied.push(m.version);
       }
       return { applied };
     });
   ```

   - Migrations are ordered, idempotent, transactional.
   - The first migration (`1.0.0`) applies the current `TABLES_DDL` set; future versions add new DDL.

2. **`connection.ts` integration**:
   - Replace the `for (const ddl of TABLES_DDL) ...` loop (lines 33-38) with a single `yield* applyMigrations(handle)` call.
   - Keep the `PRAGMAS` apply step above.
   - Keep the `integrity_check` step.

3. **`schema/rows.ts` extension** — add 6 missing row types:
   - `SnapshotRow` (id, session_id, event_id, state_json, event_count, created_at)
   - `ArtifactRow` (id, session_id, path, kind, sha256, size_bytes, archived_at, created_at)
   - `EdgeRow` (id, session_id, edge_type, from_entity_type, from_entity_id, to_entity_type, to_entity_id, created_at)
   - `ConstraintRuleRow` (id, condition_json, actions_json, enabled, created_at)
   - `SchemaVersionRow` (id, version, applied_at)
   - `InboxProcessedRow` (id, file, processed_at)
   - All `created_at` typed as `string` (matches DDL TEXT + D3 decision). Update `EventRow.created_at` and add a comment: "SQLite TEXT — pass through Date.parse if you need Date."

4. **`tables.ts`**:
   - Add `hypotheses` table stub (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), title TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('active','weakened','rejected','promoted')), created_at TEXT NOT NULL).
   - Change `events.linked_hypothesis_id` to `TEXT REFERENCES hypotheses(id)`.

### Verification

- `migrate.test.ts` new cases:
  - Fresh DB → applyMigrations → schema_version = "1.0.0", all 10 tables present.
  - Run twice → applied.length = 0 on second run.
  - integrity_check returns "ok" after migrations.
  - foreign_key_list(events) contains `linked_hypothesis_id → hypotheses.id`.
- All 6 existing migrate tests still pass.

### Done criteria

- `pnpm -F @cognit/db test` green.
- `TABLES_DDL` array is gone from `connection.ts`; only `applyMigrations` is used.
- `PRAGMA foreign_key_list(events)` includes the `linked_hypothesis_id` row.

---

## Cycle 3 — Redaction audit gap (P0-2, `Cognit-ezs`)

### Bead

- `Cognit-ezs`

### Files

- `packages/db/src/redaction.ts`
- `packages/db/src/event-store.ts` (line 234, the filter)
- `packages/db/test/redaction.test.ts` (assert hit paths via `redactEvent`)
- `packages/db/test/event-store.test.ts` (assert `redaction_applied` rows exist for top-level and nested hits)

### Change (per decision D1.a)

1. **`redaction.ts` line 99-111**: change `redactEvent` to wrap payload + source in an envelope so `scanValue` produces non-empty paths:

   ```ts
   export const redactEvent = (
     payload: unknown,
     source: unknown,
     redactor: RedactorService,
   ): { redactedPayload: unknown; redactedSource: unknown; hits: ReadonlyArray<RedactionHit> } => {
     const payloadEnvelope = { value: payload };
     const sourceEnvelope = source === undefined ? undefined : { value: source };
     const payloadHits = redactor.scanValue(payloadEnvelope, "payload");
     const sourceHits = sourceEnvelope ? redactor.scanValue(sourceEnvelope, "source") : [];
     return {
       redactedPayload: redactor.redactValue(payload),
       redactedSource: source === undefined ? undefined : redactor.redactValue(source),
       hits: [...payloadHits, ...sourceHits],
     };
   };
   ```

   - All hits now have `fieldPath` starting with `payload.` or `source.`.
   - `redactValue` still operates on the raw payload/source so the `payload_json` shape is unchanged.

2. **`event-store.ts` line 234**: keep the filter (it now only drops truly empty paths, which shouldn't occur, but is a defensive guard). No code change needed beyond the `redactEvent` rewrite.

### Verification

- `redaction.test.ts` new case: pass a payload with a top-level string secret and a nested secret to `redactEvent`, assert that hits have `fieldPath` starting with `payload.` and that both hits appear in the returned list.
- `event-store.test.ts` extend the existing JWT test (line 125): assert that the `redaction_applied` row has `field_path` matching `payload.text` (or similar), and add a new test with a nested secret (`{ user: { token: "..." } }`) asserting the `field_path` is `payload.user.token`.
- Add a test for array-indexed path: `{ tokens: ["secret1", "secret2"] }` → two `redaction_applied` rows with `field_path = "payload.tokens[0]"` and `"payload.tokens[1]"`.

### Done criteria

- All 30 existing tests pass.
- 4 new redaction/event-store tests pass.
- The "redaction_applied events never emitted" audit finding is verifiably closed: appending an event with any secret in any nested field produces at least one `redaction_applied` row.

---

## Cycle 4 — EventStore correctness, inbox P1, EventValidator, cleanup

### Beads

- `Cognit-nl1` (P1-1) get() NotFound
- `Cognit-cpz` (P1-2) sync throws
- `Cognit-ppf` (P1-3) idempotency race
- `Cognit-825` (P1-4) EventValidator dead code
- `Cognit-eeg` (P1-7) inbox actor_type + chokidar
- `Cognit-xtb` (P1-8) appendEvent order + actor_registered + nowIso
- P2 items: test coverage gaps, `filePath` consistency, `nowIso` called twice

### Files

- `packages/db/src/event-store.ts`
- `packages/db/src/inbox.ts`
- `packages/db/src/event-schema.ts` (delete EventValidatorLive per D2.a)
- `packages/db/src/layers/live.ts` (drop EventValidatorLive from leafs)
- `packages/db/src/context.ts` (drop EventValidator Tag)
- `packages/db/src/index.ts` (drop re-export)
- `packages/db/src/migrate.ts` (drop `EventValidator` import)
- All test files

### Changes

1. **`event-store.ts` — get()** (`Cognit-nl1`):
   - Change signature in `context.ts:72` from `Effect<EventRow, never>` to `Effect<EventRow, NotFound>`.
   - Change `event-store.ts:296-303` to use `Effect.try` (mapping the undefined case to a `NotFound` failure) or split into `findEvent` returning `Effect<EventRow | undefined, never>` and a `get` wrapper that uses `Effect.fromOption` with `NotFound`.
   - The existing `get` test (event-store.test.ts:91) only covers the success path; add a missing-row test that asserts `Either.isLeft(result) && result.left._tag === "NotFound"`.

2. **`event-store.ts` — sync throws** (`Cognit-cpz`):
   - Wrap every `conn.handle.run/get/all` call inside `ensureActor`, `insertEvent`, `fetchEvent` in `Effect.try({ try: ..., catch: e => new DbError({...}) })` or use the existing `trySync`/`tryPromise` helpers from `errors.ts`.
   - The tx wrapper in `connection.ts:62` will then correctly trigger `ROLLBACK` on any failure.
   - Add a test that injects a malformed payload causing a unique-constraint violation and asserts `Effect.fail(DbError)` (not a thrown exception).

3. **`event-store.ts` — idempotency race** (`Cognit-ppf`):
   - Move the idempotency check INSIDE the tx, immediately before `insertEvent`. After `insertEvent`, if the throw is a UNIQUE-constraint violation, re-`fetchEvent` and return the existing row.
   - Concrete pattern:
     ```ts
     const result = yield* Effect.try({
       try: () => insertEvent(conn, row),
       catch: (e) => e instanceof Error && e.message.includes("UNIQUE") ? "duplicate" : new DbError({...}),
     }).pipe(Effect.catchTag("duplicate", () => Effect.sync(() => fetchEvent(conn, eventId)!)));
     ```
   - Add a test that calls `append` with the same `id` twice in rapid succession (Promise.all) and asserts both return the same row, the DB has exactly one event.

4. **`EventValidator` — delete** (`Cognit-825`, per D2.a):
   - Remove the `EventValidator` Tag from `context.ts`.
   - Remove `EventValidatorLive` from `event-schema.ts`.
   - Remove the leaf entry from `layers/live.ts:28`.
   - Remove re-export from `index.ts`.
   - `event-store.ts` and `migrate.ts` keep their inlined `Schema.decodeUnknownEither` calls — no change needed.
   - The `tests` in `event-schema.test.ts` referencing `EventValidatorLive` get deleted or migrated to assert on the inlined behavior.

5. **`event-store.ts` — actor_registered validation + nowIso + order** (`Cognit-xtb`):
   - Drop the `input.type !== "actor_registered"` skip at line 154. The `ActorRegisteredPayload` schema exists; let it validate.
   - Capture `nowIso()` once at the top of the tx body (line 195 area), reuse for both `insertEvent` calls (main event at line 229, redaction_applied at line 256).
   - Per D3.a: keep the current impl order. Update `plans/phase-1.md` and `plan.xml` to reflect it.

6. **`inbox.ts` — actor_type + chokidar** (`Cognit-eeg`):
   - Add a `Schema.decodeUnknownEither(Schema.Literal("human","worker","system"))` (or a simple tuple check) for `p.actor_type` before passing to `append`. On failure, log + move to `_error/`.
   - Change chokidar's `ignored` function to do path-segment match: split on `path.sep` and check for `_error` / `processed` segments.

7. **P2 cleanup**:
   - `event-store.ts:18,198` — decide on `filePath` consistency. **Decision: keep as-is (stored as `file_path` snake_case per JSON convention) and add a comment in `AppendEventInput` and in the test that explains the convention. Don't rename — too much surface change for a P2 nit.**
   - `event-schema.ts:220` — fix `knownVersions: () => [CURRENT_VERSION]` to accept the `type` parameter (even if unused): `knownVersions: (_type: string) => [CURRENT_VERSION]`. Add `_type` prefix to silence the lint, add a comment "all current types share a single version; per-type versions are a future concern".
   - Remove the duplicate `import { ... } from "effect"` in `event-schema.ts:1-3`.

### Verification

- All previous tests still pass.
- New tests per bead:
  - get() NotFound: append + delete + get → `Either.left(NotFound)`.
  - Sync throws: append with payload that violates a CHECK constraint → `Effect.fail(DbError)`, tx rolled back (verify by inserting a valid second event and confirming DB is consistent).
  - Idempotency race: Promise.all two appends with same id → both return same row, DB has one event.
  - actor_registered: append with invalid actor_registered payload → `Effect.fail(ValidationFailure)`.
  - nowIso: append a payload with a secret → redaction_applied event's `created_at` <= main event's `created_at`.
  - actor_type: drop a .json file with `actor_type: "alien"` into inboxDir → file moves to `_error/`, no DB row.
  - chokidar: drop a file named `my_processed.json` in inboxDir (NOT in a processed/ subdir) → it gets processed, not skipped.

### Done criteria

- All 3 P0 bugs closed.
- All 8 P1 gaps closed.
- All 2 P2 items closed.
- `pnpm -F @cognit/db test` green, ≥45 tests.
- `pnpm -r exec tsc --noEmit` clean.
- `EventValidator` removed from the entire codebase (grep -r EventValidator packages/db/src returns no matches).

---

## Post-execution

- Update `plans/phase-1.md` to reflect the actual implementation order and the D1.a / D2.a / D3.a decisions.
- Update `plan.xml` similarly (add the `hypotheses` table definition, the FK on `linked_hypothesis_id`, drop the `EventValidator` row, add the `applyMigrations` / `schema_version` reference).
- Update `STACK.md` and `CONVENTIONS.md` to mention the migration-runner pattern and the redaction-path convention (closes `Cognit-3fh`).
- Re-run `pnpm -F @cognit/db test` and the full `tsc` check.
- `git status` clean, staged, committed (no push unless asked), then close all fix beads and the phase 1 epic.

---

## Risk register

| Risk                                                                                  | Likelihood | Mitigation                                                                                                                                  |
| ------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Cycle 2's migration rewrite breaks existing tests that depend on the inline DDL apply | medium     | migrate.test.ts has 6 cases; if any fail, the rewrite is incomplete — fix and re-run                                                        |
| Cycle 3's `redactEvent` envelope change breaks the JWT redaction test                 | low        | the test only checks `payload_json` doesn't contain the secret + contains `[REDACTED:jwt]`; envelope change only affects `hits[].fieldPath` |
| Cycle 4's idempotency race fix changes the order of operations in the tx              | low        | the new test for Promise.all duplicate appends catches regressions                                                                          |
| Cycle 4 deleting `EventValidator` ripples into more files than expected               | low        | grep before delete; only 4 files reference it                                                                                               |
| `nowIso` capture at top of tx may collide with the `actor_registered` autoreg path    | low        | `actor_registered` events go through the same append path; no special handling needed                                                       |

---

## Quality gate (per cycle)

Each cycle's subagent is given the bead list + this plan section, and asked to implement only what the plan specifies. Before `bd close`, a quality-gate subagent reviews on 5 dimensions (correctness, security, edge cases, tests, completeness) and must score PASS (≥4/5) before the cycle's beads close. A FAIL triggers one retry with the findings, then escalates to adversarial verify.

---

## Decision points summary (default values applied unless user redirects)

- D1.a — wrap payload in `{ value }` envelope for `redactEvent` to thread paths.
- D2.a — delete `EventValidator` Tag entirely; keep inlined schema lookups.
- D3.a — keep current `appendEvent` impl order; amend plan.xml / phase-1.md to match.

If you want D1.b, D2.b, or D3.b, say so before the corresponding cycle starts.
