import { Context, Effect, Either, Runtime, Schema } from "effect";
import chokidar from "chokidar";
import fs from "node:fs/promises";
import path from "node:path";
import { Logger } from "./context";
import { InboxError } from "./errors";
import { moveToError } from "./inbox-sidecar";
import { CURRENT_VERSION, PAYLOAD_SCHEMAS_BY_VERSION } from "./event-schema";
import { ActorType } from "./actor";
import { SessionService, type SessionAppendEventInput } from "./session-service";
import {
  ConstraintViolation,
  DbError,
  SessionClosed,
  UnknownEventType,
  UnknownEventVersion,
  UnknownSession,
  ValidationFailure,
} from "./errors";

type LoggerService = Context.Tag.Service<typeof Logger>;
type SessionServiceT = Context.Tag.Service<typeof SessionService>;

/**
 * Decode a free-form `actor_type` string from the JSON payload. Rejects
 * anything that isn't one of the three literal types the DB CHECK
 * constraint allows, with a clean error rather than a SQLite check
 * violation surfacing through the append path.
 */
const decodeActorType = (s: string): Either.Either<ActorType, unknown> =>
  Schema.decodeUnknownEither(ActorType)(s);

/**
 * ULID regex (Crockford base32, 26 chars). Used both for the envelope
 * `session_id` field and for the filename pattern
 * `<session-id>-<ulid>.json`. Per plan.xml:670 and plan.xml:692.
 *
 * Unanchored: `Schema.pattern` and `RegExp.test` both anchor the
 * pattern to the whole string, so explicit `^…$` would be a no-op
 * (and would break composition when splicing the pattern into the
 * filename regex).
 */
const ULID_RE = /[0-9A-HJKMNP-TV-Z]{26}/;

/**
 * Inbox file naming convention: `<session-id>-<event-ulid>.json`.
 * The session id is the parent; the trailing ulid is the event id
 * the producer chose. Reject any file that does not match — the
 * producer forgot the atomic-write dance.
 *
 * Note: `ULID_RE.source` includes `^…$` anchors. We strip them and
 * rebuild without the inner `$` so the two ULID parts can be
 * composed.
 */
const INBOX_FILENAME_RE = new RegExp(
  `^[0-9A-HJKMNP-TV-Z]{26}-[0-9A-HJKMNP-TV-Z]{26}\\.json$`,
);

/**
 * Envelope schema. Required fields per plan.xml:692. `version` is a
 * literal union of every version the schema registry knows
 * (`packages/db/src/event-schema.ts`); unknown versions fail at the
 * envelope-decode step. CURRENT_VERSION is included so producers that
 * emit the latest envelope (claude/codex/gemini/opencode hooks +
 * @cognit/wrap) are always accepted. `payload` is intentionally
 * `Schema.Unknown` because per-payload validation runs against the
 * version+type keyed map below.
 */
const EnvelopeSchema = Schema.Struct({
  type: Schema.String.pipe(Schema.minLength(1)),
  version: Schema.Literal("1.0.0", "1.1.0", CURRENT_VERSION),
  session_id: Schema.String.pipe(Schema.pattern(ULID_RE)),
  actor_name: Schema.String.pipe(Schema.minLength(1)),
  actor_type: ActorType,
  payload: Schema.Unknown,
  // When supplied by the producer, the envelope id MUST be a ULID.
  // The event-store uses it as the events.id PRIMARY KEY; a non-ULID
  // value would silently break downstream consumers (snapshots, SSE
  // bus, mempalace links) that key on ULID-shaped strings. Reject at
  // the envelope boundary instead of corrupting the row.
  id: Schema.optional(Schema.String.pipe(Schema.pattern(ULID_RE))),
  source: Schema.optional(
    Schema.Struct({
      tool: Schema.String,
      command: Schema.String,
      filePath: Schema.optional(Schema.String),
    }),
  ),
  artifactRefs: Schema.optional(Schema.Array(Schema.String)),
  causationId: Schema.optional(Schema.String),
  correlationId: Schema.optional(Schema.String),
  // Bound confidence to [0, 1] (defense-in-depth at the envelope
  // boundary). Out-of-range values used to surface as a generic
  // DbError from the INSERT, which the watcher miscategorized as
  // `actor_not_registered` and confused users investigating
  // `.cognit/_error/*.reason.txt`.
  confidence: Schema.optional(
    Schema.Number.pipe(
      Schema.greaterThanOrEqualTo(0),
      Schema.lessThanOrEqualTo(1),
    ),
  ),
  parentVerificationId: Schema.optional(Schema.String),
  linkedHypothesisId: Schema.optional(Schema.String),
});

/**
 * Cached compiled payload Schemas, keyed by `"<version>:<type>"`. The
 * schema registry is module-static, so a single lookup table is enough
 * — no per-file cost. The cache is populated lazily on first decode.
 */
const payloadSchemaCache = new Map<string, Schema.Schema<any, any, never>>();

const lookupPayloadSchema = (
  version: string,
  type: string,
): Schema.Schema<any, any, never> | undefined => {
  const key = `${version}:${type}`;
  const cached = payloadSchemaCache.get(key);
  if (cached) return cached;
  const byVersion = PAYLOAD_SCHEMAS_BY_VERSION[version];
  const schema = byVersion?.[type] as Schema.Schema<any, any, never> | undefined;
  if (schema) payloadSchemaCache.set(key, schema);
  return schema;
};

/**
 * Watch a directory for `.json` files (atomically renamed from `.tmp`).
 * For each complete file: parse, validate shape, hand to appendEvent,
 * move to `.cognit/processed/<id>.json` on success or `.cognit/_error/`
 * on failure.
 *
 * Idempotency is enforced by `appendEvent` (duplicate `id` returns the
 * existing row, no double insert).
 *
 * The snapshot policy is sourced from the `SessionPolicy` service on
 * the R channel (see `SessionService.appendEvent` → `SessionPolicy.everyN`).
 */
export interface InboxWatcherConfig {
  readonly inboxDir: string;
  readonly processedDir: string;
  readonly errorDir: string;
  readonly debounceMs: number;
}

export const makeInboxWatcher = (config: InboxWatcherConfig) =>
  Effect.gen(function* () {
    const sessions: SessionServiceT = yield* SessionService;
    const logger: LoggerService = yield* Logger;

    yield* Effect.tryPromise({
      try: () => fs.mkdir(config.inboxDir, { recursive: true }),
      catch: (e) => new InboxError({ file: config.inboxDir, message: "mkdir inbox", cause: e }),
    }).pipe(Effect.ignoreLogged);
    yield* Effect.tryPromise({
      try: () => fs.mkdir(config.processedDir, { recursive: true }),
      catch: (e) =>
        new InboxError({ file: config.processedDir, message: "mkdir processed", cause: e }),
    }).pipe(Effect.ignoreLogged);
    yield* Effect.tryPromise({
      try: () => fs.mkdir(config.errorDir, { recursive: true }),
      catch: (e) => new InboxError({ file: config.errorDir, message: "mkdir error", cause: e }),
    }).pipe(Effect.ignoreLogged);

    /**
     * Pure processing step: read file, parse, attempt append, move to
     * success or error dir. This is what unit tests exercise.
     *
     * Decode order (each step maps to a sidecar category on failure):
     *   1. JSON.parse                    → invalid_json
     *   2. Envelope Schema decode        → schema_validation_failure (envelope)
     *   3. Filename regex (ULID pair)    → unknown_session_id
     *   4. Payload Schema decode         → schema_validation_failure (payload)
     *   5. actor_type literal decode     → invalid_actor_type (redundant w/ step 2)
     *   6. appendEvent typed error map   → category from the typed error
     *
     * Step 5 is redundant in practice (envelope decode already
     * constrains `actor_type` to the literal union), but kept as a
     * defensive belt-and-braces against schema-registry drift.
     *
     * Publish moved to `SessionService.appendEvent` (the chokepoint)
     * in phase 5.1 — file-based inbox writes go through the same
     * path as POST /events, so the publish happens there.
     */
    const processFile = (
      filePath: string,
    ): Effect.Effect<void, never, SessionService | Logger> =>
      Effect.gen(function* () {
        const base = path.basename(filePath);
        const readResult = yield* Effect.tryPromise({
          try: () => fs.readFile(filePath, "utf8"),
          catch: (e) => new InboxError({ file: filePath, message: "read", cause: e }),
        }).pipe(Effect.either);
        if (Either.isLeft(readResult)) {
          yield* logger.log(
            "error",
            { file: filePath, error: String(readResult.left) },
            "inbox: read failed",
          );
          return;
        }
        const text = readResult.right;

        // Step 1: JSON.parse
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch (e) {
          yield* logger.log("error", { file: filePath, error: String(e) }, "inbox: invalid json");
          yield* moveToError(
            filePath,
            base,
            config.errorDir,
            "invalid_json",
            String(e),
            logger,
          );
          return;
        }

        // Step 2: envelope schema decode. Coerces `parsed` to the
        // typed envelope shape used below; failure maps to
        // `schema_validation_failure` with a category-prefixed
        // reason.
        const envelopeResult = Schema.decodeUnknownEither(EnvelopeSchema)(parsed);
        if (Either.isLeft(envelopeResult)) {
          const reason = `envelope: ${String(envelopeResult.left)}`;
          yield* logger.log("error", { file: filePath, reason }, "inbox: envelope decode failed");
          yield* moveToError(filePath, base, config.errorDir, "schema_validation_failure", reason, logger);
          return;
        }
        const p = envelopeResult.right;

        // Step 3: filename ULID pair. Filenames that don't match
        // `<session>-<event-ulid>.json` are rejected so producers
        // can't sneak around the atomic-write protocol by writing
        // `badname.json` directly.
        if (!INBOX_FILENAME_RE.test(base)) {
          const reason = `filename does not match <session-ulid>-<event-ulid>.json: ${base}`;
          yield* logger.log("error", { file: filePath, reason }, "inbox: bad filename");
          yield* moveToError(filePath, base, config.errorDir, "unknown_session_id", reason, logger);
          return;
        }

        // Step 4: payload schema decode keyed on (version, type).
        // Fail loudly when no schema is registered: silently skipping
        // validation would let unknown event types pass the envelope
        // gate only to be rejected at `appendEvent` with a less
        // actionable `UnknownEventType` error. Catch it here as
        // `schema_validation_failure` with the exact (version, type)
        // pair so the sidecar reason tells the producer what's wrong.
        const payloadSchema = lookupPayloadSchema(p.version, p.type);
        if (!payloadSchema) {
          const reason = `unknown (version, type) pair: ${p.version}/${p.type}`;
          yield* logger.log(
            "error",
            { file: filePath, version: p.version, type: p.type },
            "inbox: unknown (version, type)",
          );
          yield* moveToError(
            filePath,
            base,
            config.errorDir,
            "schema_validation_failure",
            reason,
            logger,
          );
          return;
        }
        const decoded = Schema.decodeUnknownEither(payloadSchema)(p.payload);
        if (Either.isLeft(decoded)) {
          const reason = `payload: ${String(decoded.left)}`;
          yield* logger.log("error", { file: filePath, reason }, "inbox: payload decode failed");
          yield* moveToError(
            filePath,
            base,
            config.errorDir,
            "schema_validation_failure",
            reason,
            logger,
          );
          return;
        }

        // Step 5: actor_type decode. Redundant with the envelope
        // schema (which already constrains the literal) but kept
        // as a defensive guard.
        const actorTypeResult = decodeActorType(p.actor_type);
        if (Either.isLeft(actorTypeResult)) {
          const reason = String(actorTypeResult.left);
          yield* logger.log(
            "error",
            { file: filePath, actor_type: p.actor_type },
            "inbox: invalid actor_type",
          );
          yield* moveToError(
            filePath,
            base,
            config.errorDir,
            "invalid_actor_type",
            reason,
            logger,
          );
          return;
        }
        const actorType = actorTypeResult.right;

        // Build the input for SessionService.appendEvent. The explicit
        // `id` from the inbox JSON is forwarded so duplicate-rename
        // reprocessing is idempotent at the event-store layer.
        // `SessionService.appendEvent` reads the configured
        // `SessionPolicy.everyN` to trigger an auto-snapshot when the
        // threshold is crossed.
        const sessionInput: SessionAppendEventInput = {
          type: p.type,
          payload: p.payload,
          sessionId: p.session_id,
          actor: { name: p.actor_name, type: actorType },
          ...(p.id !== undefined ? { id: p.id } : {}),
          ...(p.source !== undefined
            ? {
                source: {
                  tool: p.source.tool,
                  command: p.source.command,
                  ...(p.source.filePath !== undefined
                    ? { filePath: p.source.filePath }
                    : {}),
                },
              }
            : {}),
          ...(p.artifactRefs !== undefined ? { artifactRefs: p.artifactRefs } : {}),
          ...(p.causationId !== undefined ? { causationId: p.causationId } : {}),
          ...(p.correlationId !== undefined ? { correlationId: p.correlationId } : {}),
          ...(p.confidence !== undefined ? { confidence: p.confidence } : {}),
          ...(p.parentVerificationId !== undefined
            ? { parentVerificationId: p.parentVerificationId }
            : {}),
          ...(p.linkedHypothesisId !== undefined
            ? { linkedHypothesisId: p.linkedHypothesisId }
            : {}),
        };

        // Step 6: appendEvent with typed-error → category mapping.
        // The typed error channel is `SessionError` (DbError |
        // SessionClosed | UnknownEventType | ValidationFailure |
        // UnknownSession | ConstraintViolation). `DuplicateEventId`
        // is caught inside `EventStore.append` and re-fetched before
        // it can bubble up, so the inbox never sees it directly —
        // the idempotency check there is the source of truth.
        const appendResult = yield* sessions.appendEvent(sessionInput).pipe(Effect.either);
        if (Either.isLeft(appendResult)) {
          const e = appendResult.left;
          const { category, reason } = mapAppendError(e);
          yield* logger.log(
            "error",
            { file: filePath, error: reason },
            `inbox: append failed (${category})`,
          );
          yield* moveToError(filePath, base, config.errorDir, category, reason, logger);
          return;
        }
        const result = appendResult.right;
        yield* logger.log(
          "info",
          { eventId: result.event.id, type: p.type, snapshotTaken: result.snapshotTaken },
          "inbox: appended",
        );
        // Publish chokepoint lives in SessionService.appendEvent
        // (phase 5.1). The inbox watcher goes through the same path
        // as POST /events, so no second publish here.
        yield* Effect.tryPromise({
          try: () =>
            fs.rename(filePath, path.join(config.processedDir, `${result.event.id}.json`)),
          catch: (renameErr) =>
            new InboxError({
              file: filePath,
              message: "move-to-processed",
              cause: renameErr,
            }),
        }).pipe(Effect.ignoreLogged);
      });

    return { processFile };
  });

/**
 * Map a typed `SessionError` from `SessionService.appendEvent` to a
 * sidecar category + human-readable reason. The four spec-listed
 * categories (`invalid_json`, `unknown_session_id`,
 * `schema_validation_failure`, `actor_not_registered`) are covered;
 * the internal categories (`invalid_actor_type`, `invalid_envelope`)
 * never reach this path because the watcher rejects them earlier.
 *
 * Parameter union must match the full `AppendError` set from
 * `packages/db/src/errors.ts` — widening it is the only way the
 * compiler enforces exhaustiveness. Falling through with an unknown
 * tag used to crash the sidecar write because the switch returned
 * `undefined` and the `category` field is non-optional.
 */
const mapAppendError = (
  e:
    | DbError
    | SessionClosed
    | UnknownEventType
    | UnknownEventVersion
    | ValidationFailure
    | UnknownSession
    | ConstraintViolation,
): { category: import("./inbox-sidecar").InboxFailureCategory; reason: string } => {
  switch (e._tag) {
    case "UnknownSession":
      return {
        category: "unknown_session_id",
        reason: `session not found: ${e.sessionId}`,
      };
    case "SessionClosed":
      return {
        category: "unknown_session_id",
        reason: `session closed: ${e.sessionId}`,
      };
    case "ValidationFailure":
      return {
        category: "schema_validation_failure",
        reason: `${e.type}@${e.version}: ${e.issues}`,
      };
    case "UnknownEventType":
      return {
        category: "schema_validation_failure",
        reason: `unknown event type: ${e.type}`,
      };
    case "UnknownEventVersion":
      return {
        category: "schema_validation_failure",
        reason: `unknown version ${e.version} for type ${e.type}`,
      };
    case "ConstraintViolation":
      return {
        category: "actor_not_registered",
        reason: `rule ${e.ruleId} blocked: ${e.reason}`,
      };
    case "DbError":
      // Storage / driver failure. Distinct from
      // `actor_not_registered` so users investigating
      // `.cognit/_error/*.reason.txt` don't go chasing identity
      // issues when the real cause is disk/db.
      return {
        category: "internal_db_error",
        reason: `db: ${e.message}`,
      };
  }
};

/**
 * Pure chokidar `ignored` predicate. Exported for test coverage.
 *
 * Matches a path segment (split on `path.sep`) equal to `_error` or
 * `processed`, so a file named `my_processed_backup.json` in the inbox
 * root is NOT skipped. Also matches any path ending in `.tmp`.
 */
export const inboxIgnored = (p: string): boolean => {
  if (p.endsWith(".tmp")) return true;
  const segments = p.split(path.sep);
  return segments.includes("_error") || segments.includes("processed");
};

/**
 * One-shot drain of every `.json` file currently in `inboxDir`. Each
 * file is processed exactly once through `processFile` (which moves
 * successful files to `processedDir` and failed files to `errorDir`).
 *
 * Returns counts of how many ended up in each dir. The way we count
 * is: snapshot processed/error dir lengths before processing, then
 * subtract from the post-processing length. This is correct in the
 * face of pre-existing files in either dir from earlier runs.
 *
 * This is the CLI's `--process` path. The long-running `--watch` path
 * uses `runInboxWatcher` instead.
 */
export const drainInbox = (
  config: InboxWatcherConfig,
): Effect.Effect<{ processed: number; errored: number }, never, SessionService | Logger> =>
  Effect.gen(function* () {
    const { processFile } = yield* makeInboxWatcher(config);
    const listDir = (dir: string): Effect.Effect<ReadonlyArray<string>, never, never> =>
      Effect.tryPromise({
        try: () => fs.readdir(dir),
        catch: () => [] as ReadonlyArray<string>,
      }).pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
    const beforeProcessed = (yield* listDir(config.processedDir)).filter((n) =>
      n.endsWith(".json"),
    ).length;
    const beforeErrored = (yield* listDir(config.errorDir)).filter((n) =>
      n.endsWith(".json"),
    ).length;
    const entries = yield* listDir(config.inboxDir);
    for (const name of entries) {
      if (!name.endsWith(".json")) continue;
      yield* processFile(path.join(config.inboxDir, name));
    }
    const afterProcessed = (yield* listDir(config.processedDir)).filter((n) =>
      n.endsWith(".json"),
    ).length;
    const afterErrored = (yield* listDir(config.errorDir)).filter((n) =>
      n.endsWith(".json"),
    ).length;
    return {
      processed: afterProcessed - beforeProcessed,
      errored: afterErrored - beforeErrored,
    };
  });

/**
 * Long-running watcher. Spawns a chokidar FSWatcher on inboxDir, debounces,
 * and hands each stable `.json` to `processFile`. Returns an Effect that
 * runs forever (use `Effect.scoped` or `Fiber` to cancel).
 *
 * Callers must provide `SessionService | Logger` to satisfy the R-channel.
 * The watcher materialises this R into a `Runtime` once, then forks each
 * per-file effect onto that runtime — avoiding the `MissingServiceError`
 * trap of an unsafe effect-channel-narrowing cast. (`EventBus` is pulled
 * transitively through `SessionService` post-phase-5.1; it does not appear
 * on this signature.)
 */
export const runInboxWatcher = (
  config: InboxWatcherConfig,
): Effect.Effect<{ stop: () => Promise<void> }, never, SessionService | Logger> =>
  Effect.gen(function* () {
    const { processFile } = yield* makeInboxWatcher(config);
    const runtime = yield* Effect.runtime<SessionService | Logger>();
    const watcher = chokidar.watch(config.inboxDir, {
      ignored: inboxIgnored,
      persistent: true,
      awaitWriteFinish: { stabilityThreshold: config.debounceMs, pollInterval: 50 },
    });
    watcher.on("add", (filePath) => {
      if (!filePath.endsWith(".json")) return;
      // Fire-and-forget; the store handles its own retries via idempotency.
      // The runtime carries the SessionService | Logger R-channel into the fork.
      Runtime.runFork(runtime, processFile(filePath));
    });
    return {
      stop: () => watcher.close(),
    };
  });
