import { Command } from "commander";
import * as fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import { create as tarCreate } from "tar";
import BetterSqlite3 from "better-sqlite3";
import { vacuumInto, CURRENT_VERSION, DB_SCHEMA_VERSION } from "@cognit/db";
import { Effect } from "effect";
import { findProjectRoot, projectPaths } from "../paths.js";
import { readConfig } from "../yaml-io.js";
import { getOutputMode, emit } from "../output.js";

/**
 * `cognit export` — produce a lossless tar.gz bundle of a project's
 * local state. The bundle is the round-trip unit consumed by
 * `cognit import`.
 *
 * Layout (top-level entries; relative to the tar root):
 *   manifest.json   — version + project metadata
 *   cognit.yaml     — the project's config
 *   cognit.db       — SQLite snapshot via `VACUUM INTO`
 *   artifacts/      — only when --include-artifacts is passed
 *
 * Why a fresh sqlite handle for the vacuum? `VACUUM INTO` builds a
 * snapshot of the main DB file from a read transaction; opening a
 * separate short-lived handle is the standard recipe (matches the
 * SQLite docs) and keeps the long-lived connection's state
 * untouched.
 *
 * --include-artifacts: copies every regular file under
 *   .cognit/artifacts/ into the bundle's `artifacts/` directory. We
 *   do NOT consult the `artifacts` table here — the table is a row
 *   index, the on-disk files are the source of truth.
 */
const BUNDLE_FORMAT_VERSION = 1 as const;

export function registerExport(program: Command): void {
  program
    .command("export")
    .description(
      "export the current project to a tar.gz bundle (manifest + cognit.yaml + cognit.db + optional artifacts/)",
    )
    .requiredOption("--output <path>", "path to the output .tar.gz file")
    .option("--include-artifacts", "include .cognit/artifacts/ contents in the bundle")
    .option("--root <path>", "project root (defaults to nearest .cognit/cognit.yaml)")
    .action(
      async (opts: {
        output: string;
        includeArtifacts?: boolean;
        root?: string;
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
        const config = await readConfig(paths.config);
        const outAbs = path.resolve(process.cwd(), opts.output);
        const outDir = path.dirname(outAbs);
        try {
          await fs.mkdir(outDir, { recursive: true });
        } catch (e) {
          process.stderr.write(
            `cognit: cannot create output dir ${outDir}: ${(e as Error).message}\n`,
          );
          process.exitCode = 1;
          return;
        }

        const work = await fs.mkdtemp(path.join(os.tmpdir(), "cognit-export-"));
        let bytesWritten = 0;
        let artifactCount = 0;
        try {
          // 1. Dump the DB. Fresh handle so we don't disturb the
          //    long-lived DbConnection layer.
          const freshHandle = new BetterSqlite3(paths.db, { readonly: false });
          try {
            await Effect.runPromise(
              vacuumInto(freshHandle as never, path.join(work, "cognit.db")),
            );
          } catch (e) {
            process.stderr.write(
              `cognit: vacuumInto failed: ${(e as Error).message}\n`,
            );
            process.exitCode = 1;
            return;
          } finally {
            freshHandle.close();
          }

          // 2. Copy cognit.yaml verbatim. The bundle consumer parses
          //    it as a fresh config — no rewriting.
          await fs.copyFile(paths.config, path.join(work, "cognit.yaml"));

          // 3. Optional artifacts/. Skip silently when the dir does
          //    not exist (no artifacts have ever been written) — that
          //    is the common case for a fresh project.
          if (opts.includeArtifacts) {
            try {
              const dirStat = await fs.stat(paths.artifacts);
              if (dirStat.isDirectory()) {
                await copyDir(paths.artifacts, path.join(work, "artifacts"));
                const files = await walk(path.join(work, "artifacts"));
                artifactCount = files.length;
              }
            } catch (e) {
              const code = (e as NodeJS.ErrnoException).code;
              if (code !== "ENOENT") {
                process.stderr.write(
                  `cognit: cannot copy artifacts/: ${(e as Error).message}\n`,
                );
                process.exitCode = 1;
                return;
              }
            }
          }

          // 4. Manifest last — every other entry is on disk by now.
          // D-M6-00 KD-2: schema_version is DB DDL head, not payload CURRENT_VERSION.
          let dbSchemaVersion: string = DB_SCHEMA_VERSION;
          try {
            const schemaDb = new BetterSqlite3(path.join(work, "cognit.db"), {
              readonly: true,
            });
            try {
              const row = schemaDb
                .prepare("SELECT version FROM schema_version WHERE id = 1")
                .get() as { version?: string } | undefined;
              if (row?.version) dbSchemaVersion = row.version;
            } finally {
              schemaDb.close();
            }
          } catch {
            /* keep DB_SCHEMA_VERSION fallback */
          }
          const manifest = {
            format_version: BUNDLE_FORMAT_VERSION,
            created_at: new Date().toISOString(),
            project_name: config.project.name,
            schema_version: dbSchemaVersion,
            payload_version: CURRENT_VERSION,
          };
          await fs.writeFile(
            path.join(work, "manifest.json"),
            JSON.stringify(manifest, null, 2) + "\n",
            "utf8",
          );

          // 5. Tar.gz. `tar.create({ file, gzip, cwd }, entries)` writes
          //    directly to `file` and resolves when the stream is
          //    closed. We must enumerate every entry explicitly —
          //    tar@7 does not recurse without a list.
          const entries = await fs.readdir(work);
          try {
            await tarCreate(
              {
                cwd: work,
                gzip: true,
                portable: true,
                file: outAbs,
              },
              entries,
            );
          } catch (e) {
            process.stderr.write(
              `cognit: tar failed: ${(e as Error).message}\n`,
            );
            process.exitCode = 1;
            return;
          }

          const outStat = await fs.stat(outAbs);
          bytesWritten = outStat.size;
        } finally {
          await fs.rm(work, { recursive: true, force: true });
        }

        if (getOutputMode() === "json") {
          emit("json", "export", {
            output: outAbs,
            formatVersion: BUNDLE_FORMAT_VERSION,
            schemaVersion: DB_SCHEMA_VERSION,
            payloadVersion: CURRENT_VERSION,
            projectName: config.project.name,
            includeArtifacts: !!opts.includeArtifacts,
            artifactCount,
            bytesWritten,
          });
          return;
        }
        process.stdout.write(`exported to ${outAbs}\n`);
        process.stdout.write(
          `  format_version: ${BUNDLE_FORMAT_VERSION}\n  schema_version: ${CURRENT_VERSION}\n  size:           ${bytesWritten} bytes\n`,
        );
        if (opts.includeArtifacts) {
          process.stdout.write(`  artifacts:      ${artifactCount} file(s)\n`);
        }
      },
    );
}

// --- helpers ------------------------------------------------------------

const copyDir = async (src: string, dest: string): Promise<void> => {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(from, to);
    } else if (entry.isFile()) {
      await fs.copyFile(from, to);
    }
  }
};

const walk = async (root: string): Promise<string[]> => {
  const out: string[] = [];
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const e of entries) {
    const p = path.join(root, e.name);
    if (e.isDirectory()) {
      out.push(...(await walk(p)));
    } else if (e.isFile()) {
      out.push(p);
    }
  }
  return out;
};

// Re-exports for tests.
export { createReadStream, BUNDLE_FORMAT_VERSION };
