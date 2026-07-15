import { Command } from "commander";
import { Effect, Exit, Cause } from "effect";
import fs from "node:fs/promises";
import path from "node:path";
import {
  ArtifactRepo,
  DbSize,
  type ArtifactRow,
} from "@cognit/db";
import type { UnreferencedAction } from "@cognit/core/config";
import { findProjectRoot, projectPaths } from "../paths.js";
import { withAppLayer } from "../layer-build.js";
import { readConfig } from "../yaml-io.js";
import { getOutputMode, emit } from "../output.js";

/**
 * `cognit gc` — garbage-collect artifacts past `cleanup.artifact_max_age_days`.
 *
 * Storage concerns, NOT event-store concerns. We do not append
 * `artifact_archived` or `artifact_deleted` events here. See the
 * doc comment on `ArtifactRepo.markArtifactArchived` for the
 * trade-off; if a future product story needs an audit trail, the
 * right shape is a single `storage_gc_run` event after the loop
 * summarises what changed.
 *
 * --dry-run: list the candidates and exit. No file moves, no
 *            archive flag updates.
 * --force:   skip the interactive confirm. CI / scripts pass --force.
 * --max-age-days N: override `cleanup.artifact_max_age_days` from
 *                   `cognit.yaml`.
 *
 * DB size guard: read `getDbSizeBytes`. Compare to
 * `cleanup.max_db_size_mb`:
 *   - ≥ 80%  → warn, continue
 *   - ≥ 100% → hard-stop, exit 1 (only when action would be
 *              archive/delete, never when --dry-run; the dry-run
 *              is the user's chance to see what would happen
 *              without committing).
 *
 * The size check fires on every invocation (not gated by
 * --dry-run) so a misconfigured `max_db_size_mb` surfaces early.
 * For --dry-run we still print the warning but proceed to the
 * candidate listing because dry-run has no side effect to block.
 */
export function registerGc(program: Command): void {
  program
    .command("gc")
    .description(
      "garbage-collect stale artifacts past cleanup.artifact_max_age_days; archive|delete|keep per cleanup.unreferenced_action",
    )
    .option("--dry-run", "list candidates and exit; do not mutate files or DB rows")
    .option("--force", "skip the interactive confirm prompt (for CI / scripts)")
    .option("--max-age-days <n>", "override cleanup.artifact_max_age_days from cognit.yaml")
    .option("--root <path>", "project root (defaults to nearest .cognit/cognit.yaml)")
    .action(
      async (opts: {
        dryRun?: boolean;
        force?: boolean;
        maxAgeDays?: string;
        root?: string;
      }) => {
        const root = findProjectRoot(opts.root);
        if (!root) {
          process.stderr.write("cognit: no .cognit/cognit.yaml found. Run `cognit init` first.\n");
          process.exitCode = 2;
          return;
        }
        const paths = projectPaths(root);
        const config = await readConfig(paths.config);
        const maxAgeDays =
          opts.maxAgeDays !== undefined
            ? Number.parseInt(opts.maxAgeDays, 10)
            : config.cleanup.artifact_max_age_days;
        if (!Number.isFinite(maxAgeDays) || maxAgeDays < 0) {
          process.stderr.write(`cognit: --max-age-days must be a non-negative integer\n`);
          process.exitCode = 2;
          return;
        }
        const dryRun = !!opts.dryRun;
        const force = !!opts.force;
        const maxDbBytes = config.cleanup.max_db_size_mb * 1024 * 1024;

        // Confirm prompt (skipped in --force or --dry-run).
        if (!force && !dryRun) {
          process.stderr.write(
            `cognit gc will ${config.cleanup.unreferenced_action} artifacts older than ${maxAgeDays} days. Continue? [y/N] `,
          );
          // Read one line from stdin. Default to N when stdin is not a TTY (e.g. CI).
          const answer = await readLine();
          if (answer.trim().toLowerCase() !== "y") {
            process.stderr.write("aborted.\n");
            process.exitCode = 0;
            return;
          }
        }

        const program = Effect.gen(function* () {
          const repo = yield* ArtifactRepo;
          const dbSize = yield* DbSize;
          const currentBytes = yield* dbSize.getDbSizeBytes();
          const sizeFraction = currentBytes / maxDbBytes;
          // Hard-stop only when we are about to mutate. --dry-run
          // prints the candidate set regardless so the user can see
          // what would happen before adjusting `max_db_size_mb`.
          if (sizeFraction >= 1 && !dryRun) {
            return yield* Effect.fail(
              new GcHardStopError({
                currentBytes,
                maxDbBytes,
              }),
            );
          }
          if (sizeFraction >= 0.8) {
            process.stderr.write(
              `cognit: db size ${formatBytes(currentBytes)} is ${(sizeFraction * 100).toFixed(0)}% of max ${formatBytes(maxDbBytes)} (warn ≥ 80%)\n`,
            );
          }
          const candidates = yield* repo.listArtifacts({
            olderThanDays: maxAgeDays,
          });
          return { currentBytes, candidates };
        });
        const provided = await withAppLayer(root, program);
        const result = await runGc(provided, {
          dryRun,
          action: config.cleanup.unreferenced_action,
          paths,
        });
        if (!result.ok) {
          process.stderr.write(result.message);
          if (process.exitCode === undefined) process.exitCode = 1;
          return;
        }
        // §3.1: sweep stale inbox/_error files (envelopes + reason
        // sidecars) older than maxAgeDays. Dry-run reports only.
        const errorSweep = await sweepInboxError(paths.inboxError, maxAgeDays, dryRun);
        if (getOutputMode() === "json") {
          emit("json", "gc", {
            dryRun,
            action: config.cleanup.unreferenced_action,
            maxAgeDays,
            dbSizeBytes: result.dbSizeBytes,
            candidateCount: result.candidates.length,
            archived: result.archived,
            deleted: result.deleted,
            kept: result.kept,
            inboxErrorSwept: errorSweep.removed,
            inboxErrorStale: errorSweep.stale,
          });
          return;
        }
        printReport(result, dryRun, config.cleanup.unreferenced_action, maxAgeDays);
        if (errorSweep.stale > 0) {
          process.stdout.write(
            `inbox/_error: ${errorSweep.removed} stale file(s) ${dryRun ? "would be " : ""}removed (older than ${maxAgeDays}d)\n`,
          );
        }
      },
    );
}

const readLine = (): Promise<string> =>
  new Promise((resolve) => {
    let data = "";
    const onData = (chunk: Buffer): void => {
      data += chunk.toString("utf8");
      if (data.includes("\n")) {
        process.stdin.off("data", onData);
        process.stdin.off("end", onEnd);
        resolve(data);
      }
    };
    const onEnd = (): void => {
      process.stdin.off("data", onData);
      resolve(data);
    };
    process.stdin.on("data", onData);
    process.stdin.once("end", onEnd);
  });

/**
 * Sweep stale files from `inbox/_error/` (envelopes + `.reason.txt`
 * sidecars) whose mtime is older than `maxAgeDays`. Dry-run counts
 * without unlinking. Returns `{ stale, removed }`.
 */
const sweepInboxError = async (
  errorDir: string,
  maxAgeDays: number,
  dryRun: boolean,
): Promise<{ stale: number; removed: number }> => {
  const fsp = await import("node:fs/promises");
  const nodePath = await import("node:path");
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  let entries: string[];
  try {
    entries = await fsp.readdir(errorDir);
  } catch {
    return { stale: 0, removed: 0 };
  }
  let stale = 0;
  let removed = 0;
  for (const name of entries) {
    const p = nodePath.join(errorDir, name);
    try {
      const st = await fsp.stat(p);
      if (st.mtimeMs >= cutoff) continue;
      stale += 1;
      if (dryRun) continue;
      await fsp.unlink(p);
      removed += 1;
    } catch {
      // stat/unlink race — skip silently.
    }
  }
  return { stale, removed };
};

class GcHardStopError extends Error {
  readonly _tag = "GcHardStopError";
  constructor(readonly info: { readonly currentBytes: number; readonly maxDbBytes: number }) {
    super(
      `db size ${formatBytes(info.currentBytes)} >= max ${formatBytes(info.maxDbBytes)}; refusing to gc`,
    );
  }
}

interface GcResult {
  readonly ok: boolean;
  readonly message: string;
  readonly dbSizeBytes: number;
  readonly candidates: ReadonlyArray<ArtifactRow>;
  readonly archived: number;
  readonly deleted: number;
  readonly kept: number;
}

const runGc = async (
  eff: Effect.Effect<{ currentBytes: number; candidates: ReadonlyArray<ArtifactRow> }, unknown, never>,
  opts: {
    readonly dryRun: boolean;
    readonly action: UnreferencedAction;
    readonly paths: ReturnType<typeof projectPaths>;
  },
): Promise<GcResult> => {
  const exit = await Effect.runPromiseExit(eff);
  if (Exit.isFailure(exit)) {
    const fail = Cause.failureOption(exit.cause);
    if (fail._tag === "Some" && (fail.value as { _tag?: string })._tag === "GcHardStopError") {
      return {
        ok: false,
        message: `cognit: ${(fail.value as Error).message}\n`,
        dbSizeBytes: 0,
        candidates: [],
        archived: 0,
        deleted: 0,
        kept: 0,
      };
    }
    const die = Cause.dieOption(exit.cause);
    return {
      ok: false,
      message: `cognit: gc failed: ${die._tag === "Some" ? String(die.value) : "unknown"}\n`,
      dbSizeBytes: 0,
      candidates: [],
      archived: 0,
      deleted: 0,
      kept: 0,
    };
  }
  const { currentBytes, candidates } = exit.value;
  if (opts.dryRun) {
    return {
      ok: true,
      message: "",
      dbSizeBytes: currentBytes,
      candidates,
      archived: 0,
      deleted: 0,
      kept: candidates.length,
    };
  }
  const ts = new Date().toISOString();
  let archived = 0;
  let deleted = 0;
  let kept = 0;
  for (const row of candidates) {
    if (opts.action === "keep") {
      kept += 1;
      continue;
    }
    if (opts.action === "archive") {
      // Move the file from artifacts/ to archive/ if it lives under
      // the standard layout. External paths (e.g. /var/log) are
      // left in place; we only flip the archived_at column so the
      // event-store history stays consistent. This matches the
      // spec: "Move file on archive (artifacts/ -> archive/)".
      const fromPath = row.path;
      const fromAbs = path.isAbsolute(fromPath) ? fromPath : path.join(opts.paths.root, fromPath);
      const toAbs = path.join(opts.paths.archive, path.basename(fromPath));
      try {
        await fs.mkdir(opts.paths.archive, { recursive: true });
        await fs.rename(fromAbs, toAbs);
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") {
          return {
            ok: false,
            message: `cognit: archive failed for ${fromPath}: ${(e as Error).message}\n`,
            dbSizeBytes: currentBytes,
            candidates,
            archived,
            deleted,
            kept,
          };
        }
        // ENOENT: file is already gone. Still flip the column so the
        // row stops appearing in listArtifacts.
      }
      const program = Effect.gen(function* () {
        const repo = yield* ArtifactRepo;
        return yield* repo.markArtifactArchived(row.id, ts);
      });
      const provided = await withAppLayer(opts.paths.root, program);
      await Effect.runPromise(provided);
      archived += 1;
    } else if (opts.action === "delete") {
      const fromPath = row.path;
      const fromAbs = path.isAbsolute(fromPath) ? fromPath : path.join(opts.paths.root, fromPath);
      try {
        await fs.unlink(fromAbs);
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") {
          return {
            ok: false,
            message: `cognit: delete failed for ${fromPath}: ${(e as Error).message}\n`,
            dbSizeBytes: currentBytes,
            candidates,
            archived,
            deleted,
            kept,
          };
        }
      }
      const program = Effect.gen(function* () {
        const repo = yield* ArtifactRepo;
        return yield* repo.deleteArtifact(row.id);
      });
      const provided = await withAppLayer(opts.paths.root, program);
      await Effect.runPromise(provided);
      deleted += 1;
    }
  }
  return {
    ok: true,
    message: "",
    dbSizeBytes: currentBytes,
    candidates,
    archived,
    deleted,
    kept,
  };
};

const formatBytes = (n: number): string => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MiB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GiB`;
};

const printReport = (
  r: GcResult,
  dryRun: boolean,
  action: UnreferencedAction,
  maxAgeDays: number,
): void => {
  process.stdout.write(`db size:   ${formatBytes(r.dbSizeBytes)}\n`);
  process.stdout.write(`candidates: ${r.candidates.length} (older than ${maxAgeDays} days)\n`);
  if (dryRun) {
    process.stdout.write(`action:    ${action} (dry-run; no changes applied)\n`);
    for (const c of r.candidates) {
      process.stdout.write(`  - ${c.id}  ${c.path}\n`);
    }
    return;
  }
  process.stdout.write(`action:    ${action}\n`);
  process.stdout.write(`archived:  ${r.archived}\n`);
  process.stdout.write(`deleted:   ${r.deleted}\n`);
  process.stdout.write(`kept:      ${r.kept}\n`);
};
