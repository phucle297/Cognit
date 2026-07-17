import { Command } from "commander";
import { existsSync } from "node:fs";
import { rm, mkdtemp, copyFile, mkdir, readFile, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { extract } from "tar";
import BetterSqlite3 from "better-sqlite3";
import { CURRENT_VERSION } from "@cognit/db";
import { findProjectRoot, projectPaths } from "../paths.js";
import { getOutputMode, emit } from "../output.js";

/**
 * `cognit import` — re-apply a tar.gz bundle produced by
 * `cognit export` onto the current project.
 *
 * Merge strategies (controlled by --merge-strategy):
 *   skip      — local wins on id collision; imported row is dropped.
 *               Default. Safe to re-run an import any number of times.
 *   overwrite — imported row replaces local on id collision. Existing
 *               local rows that depend on the overwritten one (FKs)
 *               will fail the FK check; the CLI pre-deletes only
 *               the row itself, not the dependents. The user is
 *               expected to know the shape.
 *   fork      — every imported id is rewritten; FK columns are
 *               remapped via the local idMap. Useful for importing
 *               one project's history into a different project
 *               without clobbering either side.
 *
 * Cross-version payloads: v1.0.0 rows imported into a v1.1.0 project
 * keep their original `version` column value. The on-read migration
 * in `EventStore.list/get` lifts them to CURRENT_VERSION when
 * consumed. That keeps the bundle a true byte-equal snapshot
 * (re-export round-trips) while the live view is always current.
 *
 * Bad manifest (unknown format_version, missing fields) → typed
 * ImportError with code=bad_manifest and a non-zero exit.
 */

type MergeStrategy = "skip" | "overwrite" | "fork";

const BUNDLE_FORMAT_VERSION = 1 as const;

interface ParsedManifest {
  readonly format_version: number;
  readonly created_at: string;
  readonly project_name: string;
  readonly schema_version: string;
}

export class ImportError extends Error {
  readonly _tag = "ImportError";
  constructor(
    message: string,
    readonly code: "no_project" | "bad_manifest" | "io" | "merge" | "extract",
  ) {
    super(message);
  }
}

export function registerImport(program: Command): void {
  program
    .command("import")
    .description(
      "import a tar.gz bundle produced by `cognit export` into the current project (skip|overwrite|fork)",
    )
    .requiredOption("--input <path>", "path to the input .tar.gz file")
    .option(
      "--merge-strategy <strategy>",
      "skip (default) | overwrite | fork",
      (v) => v,
      "skip" as MergeStrategy,
    )
    .option("--root <path>", "project root (defaults to nearest .cognit/cognit.yaml)")
    .action(
      async (opts: {
        input: string;
        mergeStrategy?: string;
        root?: string;
      }) => {
        const strategy = parseStrategy(opts.mergeStrategy);
        if (!strategy) {
          process.stderr.write(
            `cognit: --merge-strategy must be one of skip|overwrite|fork, got: ${opts.mergeStrategy}\n`,
          );
          process.exitCode = 2;
          return;
        }
        // Project presence first — a missing project is a
        // configuration problem the user must fix before the
        // import can possibly succeed. The input-file check is
        // secondary; reporting "no project" when both are wrong
        // helps the user diagnose the harder problem first.
        const root = findProjectRoot(opts.root);
        if (!root) {
          process.stderr.write(
            "cognit: no .cognit/cognit.yaml found. Run `cognit init` first.\n",
          );
          process.exitCode = 2;
          return;
        }
        const paths = projectPaths(root);
        const inAbs = path.resolve(process.cwd(), opts.input);
        if (!existsSync(inAbs)) {
          process.stderr.write(`cognit: input file does not exist: ${inAbs}\n`);
          process.exitCode = 2;
          return;
        }

        const work = await mkdtemp(path.join(os.tmpdir(), "cognit-import-"));
        let imported = 0;
        let skipped = 0;
        let forked = 0;
        let overwritten = 0;
        let manifest: ParsedManifest | null = null;
        try {
          // 1. Extract the tarball.
          try {
            await extract({ file: inAbs, cwd: work, gzip: true });
          } catch (e) {
            process.stderr.write(
              `cognit: extract failed: ${(e as Error).message}\n`,
            );
            process.exitCode = 1;
            return;
          }

          // 2. Validate the manifest.
          try {
            const raw = await readFile(path.join(work, "manifest.json"), "utf8");
            const parsed = JSON.parse(raw) as unknown;
            const m = parsed as Partial<ParsedManifest>;
            if (
              typeof m.format_version !== "number" ||
              typeof m.created_at !== "string" ||
              typeof m.project_name !== "string" ||
              typeof m.schema_version !== "string"
            ) {
              throw new Error("manifest is missing required fields");
            }
            if (m.format_version !== BUNDLE_FORMAT_VERSION) {
              throw new Error(
                `unsupported bundle format_version ${m.format_version}; this CLI only reads ${BUNDLE_FORMAT_VERSION}`,
              );
            }
            manifest = m as ParsedManifest;
          } catch (e) {
            process.stderr.write(
              `cognit: bad manifest: ${(e as Error).message}\n`,
            );
            process.exitCode = 1;
            return;
          }

          // 3. Open the imported DB and read every row from the
          //    round-tripped tables. We depend on `cognit.db` being
          //    a self-contained SQLite file (the export guarantees
          //    this via VACUUM INTO).
          const importedDbPath = path.join(work, "cognit.db");
          if (!existsSync(importedDbPath)) {
            process.stderr.write(`cognit: bundle is missing cognit.db\n`);
            process.exitCode = 1;
            return;
          }
          const importedHandle = new BetterSqlite3(importedDbPath, { readonly: true });
          let rowsByTable: ReadonlyMap<string, ReadonlyArray<Record<string, unknown>>>;
          try {
            rowsByTable = readAllRows(importedHandle);
          } finally {
            importedHandle.close();
          }

          // 4. Open the local DB. Direct INSERTs (we bypass the
          //    EventStore chokepoint for bulk historical rows — the
          //    data is already redacted and validated when it was
          //    first appended; the round-trip is data-only).
          const localHandle = new BetterSqlite3(paths.db, { readonly: false });
          try {
            const stats = applyImport(localHandle, rowsByTable, strategy);
            imported = stats.imported;
            skipped = stats.skipped;
            forked = stats.forked;
            overwritten = stats.overwritten;
          } finally {
            localHandle.close();
          }

          // 5. Copy any artifacts/ the bundle carried. Skip silently
          //    when --include-artifacts wasn't used at export time
          //    (the dir simply doesn't exist in the bundle).
          const bundleArtifacts = path.join(work, "artifacts");
          if (existsSync(bundleArtifacts)) {
            await copyDirIfMissing(bundleArtifacts, paths.artifacts);
          }
        } finally {
          await rm(work, { recursive: true, force: true });
        }

        if (getOutputMode() === "json") {
          emit("json", "import", {
            input: inAbs,
            mergeStrategy: strategy,
            imported,
            skipped,
            overwritten,
            forked,
            targetSchemaVersion: CURRENT_VERSION,
            sourceSchemaVersion: manifest?.schema_version ?? CURRENT_VERSION,
          });
          return;
        }
        process.stdout.write(
          `imported from ${inAbs}\n  strategy:        ${strategy}\n  imported:        ${imported}\n  skipped:         ${skipped}\n  overwritten:     ${overwritten}\n  forked:          ${forked}\n  source_version:  ${manifest?.schema_version ?? CURRENT_VERSION}\n`,
        );
      },
    );
}

// --- helpers ------------------------------------------------------------

const parseStrategy = (raw: string | undefined): MergeStrategy | null => {
  if (raw === "skip" || raw === "overwrite" || raw === "fork") return raw;
  return null;
};

const readAllRows = (
  db: BetterSqlite3.Database,
): ReadonlyMap<string, ReadonlyArray<Record<string, unknown>>> => {
  // Dependency order: parent tables first so FK checks pass on insert.
  // We skip `schema_version` and `inbox_processed` (operational
  // state that doesn't round-trip — schema_version is local
  // migration bookkeeping, inbox_processed is a per-machine dedup
  // log).
  // D-M6-00: raw_events before events so fork can remap correlation_id
  // via the raw_events: id map after raw rows are allocated.
  const tables = [
    "projects",
    "actors",
    "sessions",
    "hypotheses",
    "raw_events",
    "events",
    "snapshots",
    "artifacts",
    "edges",
    "constraint_rules",
  ];
  const out = new Map<string, ReadonlyArray<Record<string, unknown>>>();
  for (const t of tables) {
    const exists = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`)
      .get(t);
    if (!exists) continue;
    out.set(t, db.prepare(`SELECT * FROM ${t}`).all() as ReadonlyArray<Record<string, unknown>>);
  }
  return out;
};

interface ApplyStats {
  imported: number;
  skipped: number;
  overwritten: number;
  forked: number;
}

const applyImport = (
  db: BetterSqlite3.Database,
  rowsByTable: ReadonlyMap<string, ReadonlyArray<Record<string, unknown>>>,
  strategy: MergeStrategy,
): ApplyStats => {
  const stats: ApplyStats = { imported: 0, skipped: 0, overwritten: 0, forked: 0 };

  // Per-table id + FK columns that need remapping under the fork
  // strategy. Each entry: table name → list of column names that
  // store a foreign key into another table's `id` column.
  const fkColumnsByTable: Readonly<Record<string, ReadonlyArray<string>>> = {
    projects: [],
    actors: [],
    sessions: ["project_id", "parent_session_id"],
    hypotheses: ["session_id"],
    // D-M6-00: raw_events FKs; correlation_id on events remapped specially
    // (soft link → raw_events id map, not events map).
    raw_events: ["project_id", "session_id"],
    events: [
      "project_id",
      "session_id",
      "actor_id",
      "causation_id",
      "parent_verification_id",
      "linked_hypothesis_id",
    ],
    snapshots: ["session_id", "event_id"],
    artifacts: ["session_id"],
    edges: ["session_id"],
    constraint_rules: [],
  };

  // Build idMap for fork strategy. Key = "<table>:<oldId>",
  // value = new ULID. We allocate new ids lazily.
  const idMap = new Map<string, string>();
  const newIdFor = (table: string, oldId: string): string => {
    const key = `${table}:${oldId}`;
    let next = idMap.get(key);
    if (!next) {
      next = freshUlid();
      idMap.set(key, next);
    }
    return next;
  };
  // Track which old ids we have already inserted (idempotency).
  const seenOldIds = new Map<string, Set<string>>();
  const markInserted = (table: string, oldId: string): void => {
    let s = seenOldIds.get(table);
    if (!s) {
      s = new Set();
      seenOldIds.set(table, s);
    }
    s.add(oldId);
  };
  const wasInserted = (table: string, oldId: string): boolean =>
    !!seenOldIds.get(table)?.has(oldId);

  db.exec("BEGIN");
  try {
    for (const [table, rows] of rowsByTable) {
      const fkCols = fkColumnsByTable[table] ?? [];
      for (const row of rows) {
        const oldId = String(row.id);
        // Strategy handling per-row.
        const localExists = localIdExists(db, table, oldId);

        if (strategy === "skip" && localExists) {
          stats.skipped += 1;
          continue;
        }
        if (strategy === "fork" && wasInserted(table, oldId)) {
          // already inserted under a remapped id; nothing to do.
          continue;
        }

        const newRow: Record<string, unknown> = { ...row };
        if (strategy === "fork") {
          // 1. Allocate a new id for this table.
          newRow.id = newIdFor(table, oldId);
          // 2. Rewrite FK columns to point at the new ids.
          for (const fk of fkCols) {
            const v = newRow[fk];
            if (v == null) continue;
            const refTable = fkRefersTo(table, fk);
            if (!refTable) continue;
            const remapped = idMap.get(`${refTable}:${v}`);
            if (remapped) {
              newRow[fk] = remapped;
            } else {
              // FK target not seen in this import — leave as null so
              // the row can be re-pointed later (or kept null for
              // a top-level insert that pre-dated the dependent).
              newRow[fk] = null;
            }
          }
          // D-M6-00 KD-23: soft correlation_id → raw_events id map only
          // (not events:). Leave unchanged if no raw map entry (legacy).
          if (table === "events" && newRow.correlation_id != null) {
            const corr = String(newRow.correlation_id);
            const rawRemapped = idMap.get(`raw_events:${corr}`);
            if (rawRemapped) {
              newRow.correlation_id = rawRemapped;
            }
          }
          stats.forked += 1;
        } else if (strategy === "overwrite" && localExists) {
          // OR REPLACE below handles the write; just record the stat.
          stats.overwritten += 1;
        } else {
          stats.imported += 1;
        }

        const columns = Object.keys(newRow);
        const placeholders = columns.map(() => "?").join(", ");
        const values = columns.map((c) => newRow[c]);
        const insertSql = `INSERT OR REPLACE INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})`;
        db.prepare(insertSql).run(...values);
        markInserted(table, oldId);
      }
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return stats;
};

/**
 * Best-effort lookup of which table a given FK column on a given
 * table points at. The schema is small enough to hardcode; the
 * alternative is parsing `PRAGMA foreign_key_list(...)` per column
 * which is overkill.
 */
const fkRefersTo = (table: string, column: string): string | null => {
  const map: Readonly<Record<string, Readonly<Record<string, string>>>> = {
    sessions: { project_id: "projects", parent_session_id: "sessions" },
    hypotheses: { session_id: "sessions" },
    raw_events: { project_id: "projects", session_id: "sessions" },
    events: {
      project_id: "projects",
      session_id: "sessions",
      actor_id: "actors",
      causation_id: "events",
      parent_verification_id: "events",
      linked_hypothesis_id: "hypotheses",
    },
    snapshots: { session_id: "sessions", event_id: "events" },
    artifacts: { session_id: "sessions" },
    edges: { session_id: "sessions" },
  };
  return map[table]?.[column] ?? null;
};

const localIdExists = (db: BetterSqlite3.Database, table: string, id: string): boolean => {
  const row = db.prepare(`SELECT 1 as x FROM ${table} WHERE id = ?`).get(id);
  return row !== undefined;
};

/**
 * Generate a fresh ULID. Uses crypto.randomBytes — no need to pull
 * the `ulid` npm package into the CLI surface for this.
 */
const freshUlid = (): string => {
  const ts = Date.now().toString(36).padStart(10, "0");
  const rand = randomBytes(16).toString("hex").slice(0, 16);
  return `01${ts}${rand}`.toLowerCase();
};

const copyDirIfMissing = async (src: string, dest: string): Promise<void> => {
  await mkdir(dest, { recursive: true });
  const entries = await readdir(src, { withFileTypes: true });
  for (const e of entries) {
    const from = path.join(src, e.name);
    const to = path.join(dest, e.name);
    if (e.isDirectory()) {
      await copyDirIfMissing(from, to);
    } else if (e.isFile()) {
      // Do NOT overwrite an existing local artifact. The bundle is
      // historical context; the local copy is live state.
      try {
        await stat(to);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          await copyFile(from, to);
        }
      }
    }
  }
};

// Re-export for tests.
export { BUNDLE_FORMAT_VERSION };
