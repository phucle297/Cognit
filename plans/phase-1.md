# Phase 1 Implementation Plan

## Effect Layer Architecture

```
packages/db/
  src/
    context.ts            # All Tags (DbConnection, EventStore, Redactor, EventValidator, MigrationRegistry, Logger, Clock, Uuid)
    layers/
      live.ts             # Layer.mergeAll(LiveDbConnection, LiveEventStore, LiveRedactor, ...)
      memory.ts           # in-memory implementations for tests
    schema/
      tables.ts           # drizzle table defs
      migrations.ts       # applyMigrations(db, fs, logger)
    event-schema.ts       # per-(type,version) payload Schema registry; CURRENT_VERSION
    migrate.ts            # pure transforms: (v_in, v_out, fn)[]
    redaction.ts          # wraps @cognit/core/redaction, Effect-native
    event-store.ts        # EventStore service: appendEvent, listEvents, getEvent
    inbox.ts              # chokidar watcher → appendEvent
    ulid.ts               # ulid() + Effect Clock dep
    errors.ts             # ValidationError, RedactionError, DbCorrupted, UnknownEventType, etc.
    index.ts              # public API
  test/
    event-store.test.ts
    redaction.test.ts
    event-schema.test.ts
    migrate.test.ts
    inbox.test.ts
    fixtures/
      events-v0.0.1.json
```

## Services (Context.Tag)

| Tag                 | Methods                                                    | Depends on                                          |
| ------------------- | ---------------------------------------------------------- | --------------------------------------------------- |
| `DbConnection`      | `db`, `close`, `tx<T>(fn): Effect<T, DbError>`             | —                                                   |
| `EventStore`        | `appendEvent`, `listEvents`, `getEvent`                    | DbConnection, EventValidator, Redactor, Clock, Uuid |
| `EventValidator`    | `validate(type, version, payload): Either<ParseError, T>`  | — (pure)                                            |
| `Redactor`          | `redact(text): RedactionResult` (built-in + user patterns) | @cognit/core                                        |
| `MigrationRegistry` | `transformsFor(from, to): ReadonlyArray<Transform>`        | — (pure)                                            |
| `Clock`             | `now(): Effect<Date>`                                      | —                                                   |
| `Uuid`              | `ulid(): Effect<string>`                                   | Clock                                               |

## appendEvent flow (single tx)

```
1. validate type known
2. ensureActor(name, type, config) → actor_id, trust_score  (autoreg if new)
3. validate session exists, project exists
4. idempotency: SELECT 1 FROM events WHERE id = ?  → return existing
5. payload redact(redactor)
6. source redact
7. for each hit: insert redaction_applied (in same tx)
8. insert event row with server created_at, CURRENT_VERSION
9. return EventRow
```

## Migration utility

`(from, to) → ReadonlyArray<Transform>` from a table. Transform = `(v_in, v_out, (payload) => payload)`. Walk versions. Each transform pure, deterministic, tested. Default fixtures: `0.0.1 → 1.0.0` for a few types.

## Per-file change list

| File                                           | Change                                                                                              |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `packages/db/package.json`                     | NEW: deps effect, drizzle-orm, better-sqlite3, ulid, chokidar, @cognit/core, @cognit/core/redaction |
| `packages/db/tsconfig.json`                    | NEW: extends base, rootDir ".", outDir "dist"                                                       |
| `packages/db/src/context.ts`                   | NEW: all Tags                                                                                       |
| `packages/db/src/ulid.ts`                      | NEW: ulid() using crypto, depends on Clock                                                          |
| `packages/db/src/errors.ts`                    | NEW: tagged errors                                                                                  |
| `packages/db/src/schema/tables.ts`             | NEW: drizzle tables matching plan.xml                                                               |
| `packages/db/src/schema/migrations.ts`         | NEW: applyMigrations, schema_version tracking, integrity_check                                      |
| `packages/db/src/event-schema.ts`              | NEW: per (type, version) Schemas, CURRENT_VERSION                                                   |
| `packages/db/src/migrate.ts`                   | NEW: pure transforms + walk                                                                         |
| `packages/db/src/redaction.ts`                 | NEW: Redactor Service                                                                               |
| `packages/db/src/event-store.ts`               | NEW: EventStore Service                                                                             |
| `packages/db/src/inbox.ts`                     | NEW: chokidar watcher                                                                               |
| `packages/db/src/layers/live.ts`               | NEW: live Layer composition                                                                         |
| `packages/db/src/layers/memory.ts`             | NEW: in-memory test layer                                                                           |
| `packages/db/src/index.ts`                     | NEW: exports                                                                                        |
| `packages/db/test/event-store.test.ts`         | NEW: round-trip, idempotency, redaction, autoreg actor                                              |
| `packages/db/test/event-schema.test.ts`        | NEW: validation per type+version, current version defaults                                          |
| `packages/db/test/migrate.test.ts`             | NEW: 0.0.1 → 1.0.0, idempotency, unknown version error                                              |
| `packages/db/test/redaction.test.ts`           | NEW: built-in + user patterns via Service                                                           |
| `packages/db/test/fixtures/events-v0.0.1.json` | NEW: hand-written fixture                                                                           |
| `packages/db/test/inbox.test.ts`               | NEW: rename detection, move to processed/, duplicate skip                                           |
| `packages/cli/src/commands/append.ts`          | NEW: cognit append --type --payload --session                                                       |
| `packages/cli/src/commands/inbox.ts`           | NEW: cognit inbox --watch / --process-once                                                          |
| `packages/cli/src/index.ts`                    | edit: register new commands                                                                         |
| `packages/cli/package.json`                    | edit: add @cognit/db workspace dep                                                                  |
| `pnpm-workspace.yaml`                          | unchanged                                                                                           |
| `package.json` (root)                          | unchanged                                                                                           |

## New interfaces / types

```ts
// context.ts
export class DbConnection extends Context.Tag("DbConnection")<
  DbConnection, { db: BetterSQLite3Database; tx: <A, E>(fn: (tx: Tx) => Effect<A, E>) => Effect<A, E | DbError>; close: Effect<void> }
>() {}

export class EventStore extends Context.Tag("EventStore")<
  EventStore, {
    append: (i: AppendEventInput) => Effect<EventRow, ...>
    list: (q: ListEventsQuery) => Effect<{ events: EventRow[]; nextCursor?: string }, ...>
    get: (id: Ulid) => Effect<EventRow, NotFound>
  }
>() {}

// event-schema.ts
export const CURRENT_VERSION = "1.0.0" as const
export const EventPayloadByType: Schema<...>  // discriminated by type+version

// event-store.ts
export interface AppendEventInput {
  id?: Ulid                  // default: generated
  type: EventType
  payload: unknown           // validated against (type, CURRENT_VERSION)
  sessionId: Ulid
  actor: { name: string; type: ActorType }
  source?: { tool: string; command: string; filePath?: string }
  artifactRefs?: Ulid[]
  causationId?: Ulid
  correlationId?: string
  confidence?: number
  parentVerificationId?: Ulid
  linkedHypothesisId?: Ulid
}
export interface EventRow {
  id: Ulid; projectId: Ulid; sessionId: Ulid; actorId: Ulid
  type: string; version: string
  payloadJson: string; sourceJson?: string; artifactRefsJson?: string
  causationId?: Ulid; correlationId?: string
  confidence?: number
  parentVerificationId?: Ulid; linkedHypothesisId?: Ulid
  createdAt: Date
}
```

## Risks

- **drizzle + better-sqlite3 ts types**: drizzle-orm/better-sqlite3 has types; verify at install.
- **Effect Clock in tests**: use `Layer.succeed(Clock, { now: () => Effect.succeed(new Date(...)) })` to pin time.
- **chokidar in tests**: noisy; use `mock-fs` style or temp dir + real chokidar + cleanup. Simpler: extract `processFile(path)` pure function, test that; chokidar wiring is a thin shim, manually smoke.
- **JSON shape drift**: never trust the inbound payload to match Schema — always `Schema.decodeUnknownEither` first.
- **Inbox file → already-inserted race**: chokidar fires on rename; we move file AFTER tx commits, so a crash between insert and move replays the file → idempotency catches it.

## Replay stance

- `listEvents({ sessionId, afterEventId? })` = single source of truth for replay. Reducer (Phase 2) imports this.
- `migrate(eventRow, fromVersion, toVersion)` = pure utility called by reducer at read time. NEVER mutate the row in DB.
- Append path always writes `CURRENT_VERSION`. Reading path translates.
- Schema migration on write = forbidden (would break auditability).

## Logging

- `Effect.logDebug` for append success (only when `COGNIT_LOG=debug`)
- `Effect.logInfo` for redaction hit (no payload content)
- `Effect.logError` for failures
- `Effect.logWarning` for slow queries (>100ms)
- Test layer: `Logger.replace(Logger.defaultLogger, Logger.silent)` per-suite
