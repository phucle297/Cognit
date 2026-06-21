import fs from "node:fs/promises";
import path from "node:path";
import { Effect } from "effect";
import { InboxError } from "./errors";
import { Logger } from "./context";

type LoggerService = import("effect").Context.Tag.Service<typeof Logger>;

/**
 * The four spec-listed failure categories the inbox sidecar must
 * distinguish. Plus internal categories the watcher uses to keep
 * the failure surface unambiguous:
 *
 *   - `invalid_actor_type`: envelope decoded but `actor_type` did not
 *     match the literal schema (human|worker|system). Detected before
 *     the schema-validation pass on `payload`.
 *   - `invalid_envelope`: envelope is not an object or has the wrong
 *     shape entirely.
 *   - `internal_db_error`: driver-level SQLite failure (corruption,
 *     disk full, lock timeout). Distinct from `actor_not_registered`
 *     so `cognit doctor` can triage storage issues separately from
 *     identity issues.
 *
 * Every category maps to exactly one branch in `processFile`
 * (`packages/db/src/inbox.ts`). The sidecar `reason.txt` is always
 * category-prefixed so `cognit doctor` can grep without ambiguity.
 */
export type InboxFailureCategory =
  | "invalid_json"
  | "unknown_session_id"
  | "schema_validation_failure"
  | "actor_not_registered"
  | "invalid_actor_type"
  | "invalid_envelope"
  | "internal_db_error";

/**
 * Move a processed inbox file out of the active directory and write a
 * `<basename>.reason.txt` sidecar next to it. The sidecar's first
 * line is `"<category>: <reason>"`. Both IO calls are best-effort:
 * failures are logged but do not fail the watcher (a missing
 * sidecar is recoverable on the next inspection; a stuck watcher is
 * not).
 *
 * The file is moved (rename) rather than copied: rename is atomic on
 * the same filesystem, so the watcher cannot race itself into a
 * half-renamed state.
 */
export const moveToError = (
  filePath: string,
  baseName: string,
  errorDir: string,
  category: InboxFailureCategory,
  reason: string,
  logger: LoggerService,
): Effect.Effect<void, never> =>
  Effect.gen(function* () {
    const jsonDst = path.join(errorDir, baseName);
    const reasonDst = path.join(errorDir, `${baseName}.reason.txt`);
    yield* Effect.tryPromise({
      try: () => fs.rename(filePath, jsonDst),
      catch: (e) => new InboxError({ file: filePath, message: "rename-to-error", cause: e }),
    }).pipe(
      Effect.tapError((e) =>
        logger.log(
          "error",
          { file: filePath, error: String(e.cause) },
          "inbox: rename-to-error failed",
        ),
      ),
      Effect.ignore,
    );
    yield* Effect.tryPromise({
      try: () => fs.writeFile(reasonDst, `${category}: ${reason}\n`, "utf8"),
      catch: (e) =>
        new InboxError({ file: reasonDst, message: "write-reason-sidecar", cause: e }),
    }).pipe(
      Effect.tapError((e) =>
        logger.log(
          "error",
          { file: reasonDst, error: String(e.cause) },
          "inbox: sidecar write failed",
        ),
      ),
      Effect.ignore,
    );
  });
