import { Context, Effect, Either, Runtime, Schema } from "effect";
import chokidar from "chokidar";
import fs from "node:fs/promises";
import path from "node:path";
import { EventStore, Logger } from "./context";
import { InboxError } from "./errors";
import type { AppendEventInput } from "./event-store";
import { ActorType } from "./actor";

type EventStoreService = Context.Tag.Service<typeof EventStore>;
type LoggerService = Context.Tag.Service<typeof Logger>;

/**
 * Decode a free-form `actor_type` string from the JSON payload. Rejects
 * anything that isn't one of the three literal types the DB CHECK
 * constraint allows, with a clean error rather than a SQLite check
 * violation surfacing through the append path.
 */
const decodeActorType = (s: string): Either.Either<ActorType, unknown> =>
  Schema.decodeUnknownEither(ActorType)(s);

/**
 * Watch a directory for `.json` files (atomically renamed from `.tmp`).
 * For each complete file: parse, validate shape, hand to appendEvent,
 * move to `.cognit/processed/<id>.json` on success or `.cognit/_error/`
 * on failure.
 *
 * Idempotency is enforced by `appendEvent` (duplicate `id` returns the
 * existing row, no double insert).
 */
export interface InboxWatcherConfig {
  readonly inboxDir: string;
  readonly processedDir: string;
  readonly errorDir: string;
  readonly debounceMs: number;
}

/** Move a file. Errors are logged, not thrown — best-effort. */
const moveFile = (from: string, to: string, logger: LoggerService, label: string) =>
  Effect.gen(function* () {
    yield* Effect.tryPromise({
      try: () => fs.rename(from, to),
      catch: (e) => new InboxError({ file: from, message: `move ${label}`, cause: e }),
    }).pipe(
      Effect.tapError((e) =>
        logger.log("error", { file: from, error: String(e.cause) }, `inbox: ${label} failed`),
      ),
      Effect.ignore,
    );
  });

export const makeInboxWatcher = (config: InboxWatcherConfig) =>
  Effect.gen(function* () {
    const store: EventStoreService = yield* EventStore;
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
     */
    const processFile = (filePath: string): Effect.Effect<void, never, EventStore | Logger> =>
      Effect.gen(function* () {
        const base = path.basename(filePath);
        let text: string;
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
        text = readResult.right;
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch (e) {
          yield* logger.log("error", { file: filePath, error: String(e) }, "inbox: invalid json");
          yield* moveFile(filePath, path.join(config.errorDir, base), logger, "move-to-error");
          return;
        }
        if (!parsed || typeof parsed !== "object") {
          yield* logger.log("error", { file: filePath }, "inbox: not an object");
          yield* moveFile(filePath, path.join(config.errorDir, base), logger, "move-to-error");
          return;
        }
        const p = parsed as {
          id?: string;
          type?: string;
          session_id?: string;
          actor_name?: string;
          actor_type?: string;
          payload?: unknown;
          source?: AppendEventInput["source"];
          artifactRefs?: ReadonlyArray<string>;
          causationId?: string;
          correlationId?: string;
          confidence?: number;
          parentVerificationId?: string;
          linkedHypothesisId?: string;
        };
        if (!p.type || !p.session_id || !p.actor_name || !p.actor_type || p.payload === undefined) {
          yield* logger.log("error", { file: filePath }, "inbox: missing required fields");
          yield* moveFile(filePath, path.join(config.errorDir, base), logger, "move-to-error");
          return;
        }
        const actorTypeResult = decodeActorType(p.actor_type);
        if (Either.isLeft(actorTypeResult)) {
          yield* logger.log(
            "error",
            { file: filePath, actor_type: p.actor_type },
            "inbox: invalid actor_type",
          );
          yield* moveFile(filePath, path.join(config.errorDir, base), logger, "move-to-error");
          return;
        }
        const actorType = actorTypeResult.right;
        const appendResult = yield* store
          .append({
            ...(p.id !== undefined ? { id: p.id } : {}),
            type: p.type,
            payload: p.payload,
            sessionId: p.session_id,
            actor: { name: p.actor_name, type: actorType },
            ...(p.source !== undefined ? { source: p.source } : {}),
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
          })
          .pipe(Effect.either);
        if (Either.isLeft(appendResult)) {
          yield* logger.log(
            "error",
            { file: filePath, error: String(appendResult.left) },
            "inbox: append failed",
          );
          yield* moveFile(filePath, path.join(config.errorDir, base), logger, "move-to-error");
          return;
        }
        const result = appendResult.right;
        yield* logger.log("info", { eventId: result.id, type: p.type }, "inbox: appended");
        yield* moveFile(
          filePath,
          path.join(config.processedDir, `${result.id}.json`),
          logger,
          "move-to-processed",
        );
      });

    return { processFile };
  });

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
): Effect.Effect<{ processed: number; errored: number }, never, EventStore | Logger> =>
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
 * Callers must provide `EventStore | Logger` to satisfy the R-channel.
 * The watcher materialises this R into a `Runtime` once, then forks each
 * per-file effect onto that runtime — avoiding the `MissingServiceError`
 * trap of an unsafe effect-channel-narrowing cast.
 */
export const runInboxWatcher = (
  config: InboxWatcherConfig,
): Effect.Effect<{ stop: () => Promise<void> }, never, EventStore | Logger> =>
  Effect.gen(function* () {
    const { processFile } = yield* makeInboxWatcher(config);
    const runtime = yield* Effect.runtime<EventStore | Logger>();
    const watcher = chokidar.watch(config.inboxDir, {
      ignored: inboxIgnored,
      persistent: true,
      awaitWriteFinish: { stabilityThreshold: config.debounceMs, pollInterval: 50 },
    });
    watcher.on("add", (filePath) => {
      if (!filePath.endsWith(".json")) return;
      // Fire-and-forget; the store handles its own retries via idempotency.
      // The runtime carries the EventStore | Logger R-channel into the fork.
      Runtime.runFork(runtime, processFile(filePath));
    });
    return {
      stop: () => watcher.close(),
    };
  });
