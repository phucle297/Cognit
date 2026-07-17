/**
 * `cognit raw backfill` — D-M6-00: load `.cognit/processed/*.json`
 * into `raw_events` for pre-M6 projects. Explicit operator command
 * (not silent on open). Strict decodeEnvelope; no lazyCreate.
 */
import { Command } from "commander";
import * as fs from "node:fs/promises";
import path from "node:path";
import { Effect, Either } from "effect";
import {
  DbConnection,
  RawEventStore,
  decodeEnvelope,
  toWireEnvelope,
} from "@cognit/db";
import { findProjectRoot, projectPaths } from "../paths.js";
import { withAppLayer } from "../layer-build.js";
import { getOutputMode, emit } from "../output.js";

export function registerRaw(program: Command): void {
  const raw = program.command("raw").description("raw envelope store (D-M6-00)");

  raw
    .command("backfill")
    .description(
      "insert missing raw_events rows from .cognit/processed/*.json (strict; no session invent)",
    )
    .option("--root <path>", "project root (defaults to nearest .cognit/cognit.yaml)")
    .option("--dry-run", "scan and report without writing")
    .option("--limit <n>", "max files to process", (v) => Number(v))
    .option("--verbose", "print skip reasons")
    .action(
      async (opts: {
        root?: string;
        dryRun?: boolean;
        limit?: number;
        verbose?: boolean;
      }) => {
        const root = findProjectRoot(opts.root);
        if (!root) {
          process.stderr.write(
            "cognit: no .cognit/cognit.yaml found. Run `cognit init` first.\n",
          );
          process.exitCode = 2;
          return;
        }
        const paths = projectPaths(root);
        let files: string[] = [];
        try {
          const entries = await fs.readdir(paths.processed);
          files = entries.filter((f) => f.endsWith(".json")).sort();
        } catch (e) {
          const code = (e as NodeJS.ErrnoException).code;
          if (code === "ENOENT") {
            files = [];
          } else {
            process.stderr.write(
              `cognit: cannot read processed/: ${(e as Error).message}\n`,
            );
            process.exitCode = 1;
            return;
          }
        }
        if (opts.limit !== undefined && Number.isFinite(opts.limit) && opts.limit > 0) {
          files = files.slice(0, opts.limit);
        }

        const stats = {
          scanned: 0,
          inserted: 0,
          skipped_existing: 0,
          skipped_invalid: 0,
          skipped_unknown_session: 0,
          dry_run: !!opts.dryRun,
        };

        // Pre-read files outside Effect (async fs).
        const payloads: Array<{ file: string; text: string }> = [];
        for (const file of files) {
          stats.scanned += 1;
          const full = path.join(paths.processed, file);
          try {
            const text = await fs.readFile(full, "utf8");
            payloads.push({ file, text });
          } catch (e) {
            stats.skipped_invalid += 1;
            if (opts.verbose) {
              process.stderr.write(`skip invalid read ${file}: ${String(e)}\n`);
            }
          }
        }

        const program = Effect.gen(function* () {
          const { handle } = yield* DbConnection;
          const store = yield* RawEventStore;

          for (const { file, text } of payloads) {
            let parsed: unknown;
            try {
              parsed = JSON.parse(text);
            } catch (e) {
              stats.skipped_invalid += 1;
              if (opts.verbose) {
                process.stderr.write(`skip invalid json ${file}: ${String(e)}\n`);
              }
              continue;
            }
            const decodedE = decodeEnvelope(parsed);
            if (Either.isLeft(decodedE)) {
              stats.skipped_invalid += 1;
              if (opts.verbose) {
                process.stderr.write(
                  `skip invalid envelope ${file}: ${String(decodedE.left)}\n`,
                );
              }
              continue;
            }
            const decoded = decodedE.right;
            const rawId = decoded.id;
            if (rawId === undefined) {
              stats.skipped_invalid += 1;
              if (opts.verbose) {
                process.stderr.write(`skip missing id ${file}\n`);
              }
              continue;
            }
            const session = handle.get<{ id: string; project_id: string }>(
              "SELECT id, project_id FROM sessions WHERE id = ?",
              [decoded.sessionId],
            );
            if (session === undefined) {
              stats.skipped_unknown_session += 1;
              if (opts.verbose) {
                process.stderr.write(
                  `skip unknown session ${file}: ${decoded.sessionId}\n`,
                );
              }
              continue;
            }
            const existing = handle.get<{ id: string }>(
              "SELECT id FROM raw_events WHERE id = ?",
              [rawId],
            );
            if (existing !== undefined) {
              stats.skipped_existing += 1;
              continue;
            }
            if (opts.dryRun) {
              stats.inserted += 1;
              continue;
            }
            const countRow = handle.get<{ n: number }>(
              `SELECT COUNT(*) as n FROM events WHERE correlation_id = ? OR id = ?`,
              [rawId, rawId],
            );
            const domainEventCount = countRow?.n ?? 0;
            const wire =
              parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
                ? (parsed as Record<string, unknown>)
                : toWireEnvelope({ ...decoded, id: rawId });
            yield* store.append({
              id: rawId,
              projectId: session.project_id,
              sessionId: session.id,
              type: decoded.type,
              version: decoded.version,
              actorName: decoded.actorName,
              actorType: decoded.actorType,
              envelope: wire,
              domainEventCount,
              sourceFile: file,
            });
            stats.inserted += 1;
          }
        });

        try {
          await Effect.runPromise(withAppLayer(root, program));
        } catch (e) {
          process.stderr.write(`cognit raw backfill failed: ${String(e)}\n`);
          process.exitCode = 1;
          return;
        }

        if (getOutputMode() === "json") {
          emit("json", "raw.backfill", stats);
        } else {
          process.stdout.write(
            `raw backfill: scanned=${stats.scanned} inserted=${stats.inserted} ` +
              `skipped_existing=${stats.skipped_existing} skipped_invalid=${stats.skipped_invalid} ` +
              `skipped_unknown_session=${stats.skipped_unknown_session}` +
              (stats.dry_run ? " (dry-run)\n" : "\n"),
          );
        }
      },
    );
}
