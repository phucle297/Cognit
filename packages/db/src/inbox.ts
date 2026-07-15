import { Context, Effect, Either, Runtime } from "effect";
import chokidar from "chokidar";
import fs from "node:fs/promises";
import path from "node:path";
import { Logger } from "./context";
import { DbError, InboxError } from "./errors";
import { moveToError } from "./inbox-sidecar";
import { SessionService, type SessionAppendEventResult } from "./session-service";
import { INBOX_FILENAME_RE, mapIngestError, type IngestError } from "./envelope";

type LoggerService = Context.Tag.Service<typeof Logger>;
type SessionServiceT = Context.Tag.Service<typeof SessionService>;

/** Max in-process retries for transient DB contention (§3.3). */
const MAX_INGEST_RETRIES = 3;
/** Base backoff (ms) for the exponential retry; doubled per attempt. */
const BASE_BACKOFF_MS = 5;

/**
 * A transient DB error (SQLITE_BUSY/LOCKED) is worth a bounded in-process
 * retry. Permanent failures (corruption, disk) and validation/schema
 * errors are NOT transient — retrying cannot fix them.
 */
const isTransientDbError = (e: IngestError): boolean =>
  e._tag === "DbError" &&
  /SQLITE_BUSY|SQLITE_LOCKED|database is locked|database table is locked/i.test(
    `${e.message ?? ""} ${String((e as DbError).cause ?? "")}`,
  );

/**
 * Watch a directory for `.json` files (atomically renamed from `.tmp`).
 * For each complete file: parse, hand the envelope to the unified
 * `SessionService.ingest` entry point, move to
 * `.cognit/processed/<id>.json` on success or `.cognit/_error/` on
 * failure.
 *
 * Decode + session resolution + append all live in `ingest` (§1.5/§2).
 * The watcher owns only the file lifecycle: read, parse, the
 * file-naming protocol check, and the success/error move. Idempotency
 * is enforced inside `ingest` → `appendEvent` (duplicate `id` returns
 * the existing row, no double insert).
 */
export interface InboxWatcherConfig {
  readonly inboxDir: string;
  readonly processedDir: string;
  readonly errorDir: string;
  readonly debounceMs: number;
  /** Project id — required by `ingest` to mint a bootstrap session. */
  readonly projectId: string;
  /**
   * Project root — when set, `ingest` reads/writes the sticky
   * `.cognit/current-session` pointer so a burst of placeholder-session
   * envelopes collapses onto one bootstrap session.
   */
  readonly projectRoot?: string;
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
     * Pure processing step: read file, parse, enforce the file-naming
     * protocol, hand the envelope to `ingest`. `ingest` decodes the
     * envelope, resolves/creates the session, and appends; a typed
     * `IngestError` is mapped to a sidecar category here.
     *
     * Remaining file-level steps (each maps to a sidecar category):
     *   1. JSON.parse                    → invalid_json
     *   2. Filename regex (ULID pair)    → unknown_session_id
     * Envelope/payload/actor decode + append errors come back from
     * `ingest` and are mapped via `mapIngestError`.
     */
    const processFile = (filePath: string): Effect.Effect<void, never, SessionService | Logger> =>
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
          yield* moveToError(filePath, base, config.errorDir, "invalid_json", String(e), logger);
          return;
        }

        // Step 2: filename ULID pair. Filenames that don't match
        // `<session>-<event-ulid>.json` are rejected so producers
        // can't sneak around the atomic-write protocol by writing
        // `badname.json` directly.
        if (!INBOX_FILENAME_RE.test(base)) {
          const reason = `filename does not match <session-ulid>-<event-ulid>.json: ${base}`;
          yield* logger.log("error", { file: filePath, reason }, "inbox: bad filename");
          yield* moveToError(filePath, base, config.errorDir, "unknown_session_id", reason, logger);
          return;
        }

        // Step 3: unified ingest with bounded retry on transient DB
        // contention (§3.3). better-sqlite3 is sync; SQLITE_BUSY/LOCKED
        // is brief. Validation/schema errors are NOT retried (retrying
        // cannot fix a malformed file) — the loop breaks on the first
        // non-transient error. Idempotent via event-id dedup in append.
        let ingestResult: Either.Either<SessionAppendEventResult, IngestError>;
        for (let attempt = 0; ; attempt++) {
          const r = yield* sessions
            .ingest({
              envelope: parsed,
              projectId: config.projectId,
              ...(config.projectRoot !== undefined ? { projectRoot: config.projectRoot } : {}),
            })
            .pipe(Effect.either);
          if (Either.isRight(r) || !isTransientDbError(r.left) || attempt >= MAX_INGEST_RETRIES) {
            ingestResult = r;
            break;
          }
          yield* Effect.sleep(`${BASE_BACKOFF_MS * 2 ** attempt} millis`);
        }
        if (Either.isLeft(ingestResult)) {
          const { category, reason } = mapIngestError(ingestResult.left);
          yield* logger.log(
            "error",
            { file: filePath, error: reason },
            `inbox: ingest failed (${category})`,
          );
          yield* moveToError(filePath, base, config.errorDir, category, reason, logger);
          return;
        }
        const result = ingestResult.right;
        yield* logger.log(
          "info",
          { eventId: result.event.id, sessionId: result.event.session_id },
          "inbox: appended",
        );
        yield* Effect.tryPromise({
          try: () => fs.rename(filePath, path.join(config.processedDir, `${result.event.id}.json`)),
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

/** Sentinel file written into `inboxDir` on every successful drain. */
export const LAST_DRAIN_FILENAME = ".last-drain";

/**
 * Write the `.last-drain` stamp (ISO timestamp) so `cognit inbox status`
 * and `cognit doctor` can detect a stalled pipeline. Best-effort: a
 * write failure is logged and swallowed.
 */
const writeLastDrainStamp = (
  inboxDir: string,
): Effect.Effect<void, never, Logger> =>
  Effect.tryPromise({
    try: () => fs.writeFile(path.join(inboxDir, LAST_DRAIN_FILENAME), new Date().toISOString(), "utf8"),
    catch: (e) => new InboxError({ file: inboxDir, message: "last-drain stamp", cause: e }),
  }).pipe(Effect.ignoreLogged);

/**
 * Read the last-drain timestamp, or `null` when no drain has happened.
 * CLI-side (status/doctor); not an Effect.
 */
export const readLastDrainStamp = async (inboxDir: string): Promise<string | null> => {
  try {
    return (await fs.readFile(path.join(inboxDir, LAST_DRAIN_FILENAME), "utf8")).trim();
  } catch {
    return null;
  }
};

/**
 * Pending + errored file counts for `cognit inbox status` / doctor.
 * Pending counts only top-level `.json` envelopes in the inbox (not
 * `processed/`/`_error/` subdirs). Errored counts `.json` envelopes in
 * `_error/` (sidecar `.reason.txt` files are excluded).
 */
export const inboxFileCounts = async (dirs: {
  inboxDir: string;
  errorDir: string;
}): Promise<{ pending: number; errored: number }> => {
  const topJson = async (dir: string): Promise<number> => {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      return entries.filter((d) => d.isFile() && d.name.endsWith(".json")).length;
    } catch {
      return 0;
    }
  };
  return { pending: await topJson(dirs.inboxDir), errored: await topJson(dirs.errorDir) };
};

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
  }).pipe(
    // §3.4: stamp a successful drain so doctor/status can flag a stalled
    // pipeline. Placed LAST so the stamp only reflects a completed drain.
    Effect.tap(() => writeLastDrainStamp(config.inboxDir)),
  );

/**
 * Re-run `processFile` over every `.json` file currently in `errorDir`
 * (§6 durable retry surface). After a Cognit upgrade that fixes a
 * decode/handling bug — or once the §2 lazy-create fix has landed —
 * this salvages legacy errored files (including placeholder-session
 * files stranded before any session existed) without a manual `mv`.
 *
 * Files that now succeed move to `processedDir`; files that still fail
 * stay in `errorDir` with an updated `reason.txt` (idempotent re-run).
 * `.reason.txt` sidecars are skipped (only `.json` envelopes are
 * reprocessed). Counts: `processed` = files that moved out this run;
 * `errored` = files that remain.
 */
export const reprocessErrorDir = (
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
    const entries = yield* listDir(config.errorDir);
    let total = 0;
    for (const name of entries) {
      if (!name.endsWith(".json")) continue;
      total += 1;
      yield* processFile(path.join(config.errorDir, name));
    }
    const afterProcessed = (yield* listDir(config.processedDir)).filter((n) =>
      n.endsWith(".json"),
    ).length;
    const processed = afterProcessed - beforeProcessed;
    return { processed, errored: total - processed };
  });

/**
 * Long-running watcher. Spawns a chokidar FSWatcher on inboxDir, debounces,
 * and hands each stable `.json` to `processFile`. Returns an Effect that
 * runs forever (use `Effect.scoped` or `Fiber` to cancel).
 *
 * Callers must provide `SessionService | Logger` to satisfy the R-channel.
 * The watcher materialises this R into a `Runtime` once, then forks each
 * per-file effect onto that runtime — avoiding the `MissingServiceError`
 * trap of an unsafe effect-channel-narrowing cast.
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
