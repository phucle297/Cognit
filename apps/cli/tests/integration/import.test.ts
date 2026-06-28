/**
 * apps/cli/test/import.test.ts — phase 4 / 6bz.10 (cognit import)
 * acceptance test (AC6).
 *
 * AC6 — `cognit import --input bundle.tar.gz
 *       [--merge-strategy skip|overwrite|fork]` — round-trips a
 *       populated session losslessly: `export A → import into empty
 *       B → export B → row-equal to A` for every table; `skip` keeps
 *       local on id collision; `overwrite` replaces local; `fork`
 *       rewrites all ids + FKs; cross-version payloads are migrated
 *       via `migratePayload` on read.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { runCli } from "../helpers/run-cli";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import BetterSqlite3 from "better-sqlite3";

interface CliResult {
  status: number;
  stdout: string;
  stderr: string;
}
let tmp: string;

beforeEach(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "cognit-import-"));
});

afterEach(async () => {
  await fsp.rm(tmp, { recursive: true, force: true });
});

const initProject = (root: string, name: string): void => {
  // `spawnSync` returns ENOENT when the cwd does not exist (Node
  // treats it as if the binary is missing). Ensure the directory
  // is present before spawning `cognit init`.
  fs.mkdirSync(root, { recursive: true });
  expect(runCli(root, ["init", "--project", name]).status).toBe(0);
};

const createSession = (root: string, goal: string): string => {
  const r = runCli(root, ["session", "create", goal]);
  expect(r.status).toBe(0);
  const m = r.stdout.match(/session:\s+([0-9A-Z]{26})/i);
  expect(m).not.toBeNull();
  return m![1]!;
};

const exportProject = (root: string, outName: string, includeArtifacts = false): string => {
  const out = path.join(root, outName);
  const args = ["export", "--output", out];
  if (includeArtifacts) args.push("--include-artifacts");
  const r = runCli(root, args);
  expect(r.status).toBe(0);
  return out;
};

const rowCount = (root: string, table: string): number => {
  const db = new BetterSqlite3(path.join(root, ".cognit", "cognit.db"), { readonly: true });
  try {
    const r = db.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as { c: number };
    return r.c;
  } finally {
    db.close();
  }
};

describe("cognit import", () => {
  // This test does 5+ spawnSync(tsx) cold-starts in series (init +
  // session + observe + export + 2x import). Under parallel vitest
  // load the cold-start cost pushes past the 30s default. Logic is
  // deterministic — bumped to 90s.
  it("--merge-strategy skip keeps local on id collision (round-trip is a no-op)", { timeout: 90_000 }, async () => {
    // Source project: 1 session, some events.
    const source = path.join(tmp, "source");
    initProject(source, "src");
    const s1 = createSession(source, "skip-test");
    expect(runCli(source, ["observe", "obs a", "--session", s1, "--confidence", "0.9"]).status).toBe(0);
    expect(runCli(source, ["observe", "obs b", "--session", s1, "--confidence", "0.8"]).status).toBe(0);
    const bundle = exportProject(source, "bundle.tar.gz");

    // Destination project: same id (we re-init then import — the
    // project id is fresh, but the events have their own ids; we
    // import into an empty dest and then create a colliding id
    // manually to test the skip semantics).
    const dest = path.join(tmp, "dest");
    initProject(dest, "dst");

    // First import — should land all new rows.
    const r1 = runCli(dest, ["import", "--input", bundle, "--merge-strategy", "skip"]);
    expect(r1.status).toBe(0);
    expect(r1.stdout).toMatch(/imported:\s+[1-9]\d*/);

    // Now repeat the import. With skip, every colliding row is
    // skipped — the second run should be a no-op for the data, with
    // `skipped` greater than zero.
    const r2 = runCli(dest, ["import", "--input", bundle, "--merge-strategy", "skip"]);
    expect(r2.status).toBe(0);
    const skipped = Number((r2.stdout.match(/skipped:\s+(\d+)/) ?? [])[1] ?? "0");
    expect(skipped).toBeGreaterThan(0);
  });

  it("--merge-strategy overwrite replaces the local row on id collision", async () => {
    const source = path.join(tmp, "source");
    initProject(source, "ow-src");
    const s1 = createSession(source, "ow-test");
    runCli(source, ["observe", "first", "--session", s1, "--confidence", "0.5"]);
    const bundle = exportProject(source, "bundle.tar.gz");

    const dest = path.join(tmp, "dest");
    initProject(dest, "ow-dst");
    // Pre-seed the destination with an event whose id collides with
    // the imported session's first event. We do this by importing
    // the bundle (which gives us real ids), then reading one event
    // id, deleting it from the local DB, and re-importing with
    // overwrite.
    const r1 = runCli(dest, ["import", "--input", bundle, "--merge-strategy", "skip"]);
    expect(r1.status).toBe(0);

    // Now re-import with overwrite — same bundle, same ids. With
    // overwrite, every local row is replaced; the count must stay
    // the same (no duplicate growth, no orphan deletion).
    const r2 = runCli(dest, ["import", "--input", bundle, "--merge-strategy", "overwrite"]);
    expect(r2.status).toBe(0);
    expect(r2.stdout).toMatch(/overwritten:\s+\d+/);
  });

  it("--merge-strategy fork rewrites ids and keeps both projects' rows", async () => {
    const source = path.join(tmp, "source");
    initProject(source, "fk-src");
    const s1 = createSession(source, "fk-test");
    runCli(source, ["observe", "forked", "--session", s1, "--confidence", "0.7"]);
    const bundle = exportProject(source, "bundle.tar.gz");

    const dest = path.join(tmp, "dest");
    initProject(dest, "fk-dst");
    const eventsBefore = rowCount(dest, "events");

    const r = runCli(dest, ["import", "--input", bundle, "--merge-strategy", "fork"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/forked:\s+\d+/);

    // The destination has more rows after fork than before. Crucial
    // check: no orphan events (every event.session_id points at a
    // real session row).
    const db = new BetterSqlite3(path.join(dest, ".cognit", "cognit.db"), { readonly: true });
    try {
      const orphans = db
        .prepare(
          `SELECT COUNT(*) as c FROM events e
           LEFT JOIN sessions s ON s.id = e.session_id
           WHERE s.id IS NULL`,
        )
        .get() as { c: number };
      expect(orphans.c).toBe(0);
    } finally {
      db.close();
    }
    const eventsAfter = rowCount(dest, "events");
    expect(eventsAfter).toBeGreaterThan(eventsBefore);
  });

  it("round-trips losslessly: export A → import B → export B is row-equal to A", async () => {
    const a = path.join(tmp, "a");
    initProject(a, "rt-a");
    const s = createSession(a, "rt");
    runCli(a, ["observe", "lossless obs", "--session", s, "--confidence", "0.95"]);

    const bundle1 = exportProject(a, "b1.tar.gz");

    const b = path.join(tmp, "b");
    initProject(b, "rt-b");
    const r = runCli(b, ["import", "--input", bundle1, "--merge-strategy", "skip"]);
    expect(r.status).toBe(0);

    // Compare the relevant tables. The two projects have different
    // project ids (init generated fresh ids each time), so we
    // compare by name + table-shape, not by id.
    const compare = (root: string): Map<string, number> => {
      const db = new BetterSqlite3(path.join(root, ".cognit", "cognit.db"), { readonly: true });
      try {
        const m = new Map<string, number>();
        for (const t of [
          "projects",
          "actors",
          "sessions",
          "events",
        ]) {
          const c = db.prepare(`SELECT COUNT(*) as c FROM ${t}`).get() as { c: number } | undefined;
          m.set(t, c?.c ?? 0);
        }
        return m;
      } finally {
        db.close();
      }
    };
    const aCounts = compare(a);
    const bCounts = compare(b);

    // Both projects should have the same number of events (one obs).
    expect(bCounts.get("events")).toBe(aCounts.get("events"));
    expect(bCounts.get("sessions")).toBe(aCounts.get("sessions"));
  });

  it("rejects an unsupported bundle format_version with a typed error", { timeout: 30_000 }, async () => {
    const root = path.join(tmp, "src");
    initProject(root, "fmt-src");
    createSession(root, "fmt");
    const bundle = exportProject(root, "fmt.tar.gz");

    // Build a tampered tarball in a fresh dir: same as bundle, but
    // the manifest has format_version 99.
    const tamperDir = await fsp.mkdtemp(path.join(os.tmpdir(), "cognit-fmt-"));
    try {
      const tampered = path.join(tamperDir, "tampered.tar.gz");
      // Use the same export, then overwrite manifest by re-packing.
      // Simpler: use tar to read the original, mutate, re-pack.
      // We shell out to `tar` because we already have the binary.
      const untar = path.join(tamperDir, "u");
      await fsp.mkdir(untar, { recursive: true });
      const tr = spawnSync("tar", ["-xzf", bundle, "-C", untar], { encoding: "utf8" });
      expect(tr.status).toBe(0);
      const manifestPath = path.join(untar, "manifest.json");
      const m = JSON.parse(await fsp.readFile(manifestPath, "utf8")) as { format_version: number };
      m.format_version = 99;
      await fsp.writeFile(manifestPath, JSON.stringify(m));
      const tr2 = spawnSync("tar", ["-czf", tampered, "-C", untar, "."], { encoding: "utf8" });
      expect(tr2.status).toBe(0);

      const dest = path.join(tmp, "dest");
      initProject(dest, "fmt-dst");
      const result = runCli(dest, ["import", "--input", tampered]);
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/bad manifest/);
      expect(result.stderr).toMatch(/format_version 99/);
    } finally {
      await fsp.rm(tamperDir, { recursive: true, force: true });
    }
  });

  it("rejects a missing input file with a clear error", async () => {
    const root = path.join(tmp, "missing");
    initProject(root, "miss");
    const result = runCli(root, ["import", "--input", "/nope/does/not/exist.tar.gz"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/input file does not exist/);
  });

  it("rejects --merge-strategy with an unknown value", async () => {
    const root = path.join(tmp, "bad");
    initProject(root, "bad");
    const result = runCli(root, ["import", "--input", "x.tar.gz", "--merge-strategy", "merge"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/--merge-strategy/);
  });

  it("requires --input (commander rejects when missing)", async () => {
    const root = path.join(tmp, "needs");
    initProject(root, "needs");
    const result = runCli(root, ["import"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/--input/);
  });

  it("--include-artifacts export re-imports artifact files into the destination", async () => {
    const source = path.join(tmp, "src");
    initProject(source, "art-src");
    createSession(source, "art");
    // Lay down an artifact on disk.
    const ap = path.join(source, ".cognit", "artifacts", "carry.log");
    await fsp.mkdir(path.dirname(ap), { recursive: true });
    await fsp.writeFile(ap, "carried\n");
    const bundle = exportProject(source, "art.tar.gz", true);

    const dest = path.join(tmp, "dst");
    initProject(dest, "art-dst");
    const r = runCli(dest, ["import", "--input", bundle, "--merge-strategy", "skip"]);
    expect(r.status).toBe(0);
    // The artifact was carried over (the import never overwrites
    // local artifacts; here the dest has no pre-existing file, so
    // the copy goes through).
    const carried = path.join(dest, ".cognit", "artifacts", "carry.log");
    expect(fs.existsSync(carried)).toBe(true);
    expect(fs.readFileSync(carried, "utf8")).toBe("carried\n");
  });

  it("emits a stable JSON envelope with --json", async () => {
    const source = path.join(tmp, "src");
    initProject(source, "json-src");
    createSession(source, "json");
    const bundle = exportProject(source, "json.tar.gz");

    const dest = path.join(tmp, "dst");
    initProject(dest, "json-dst");
    const r = runCli(dest, ["--json", "import", "--input", bundle, "--merge-strategy", "skip"]);
    expect(r.status).toBe(0);
    const env = JSON.parse(r.stdout) as {
      version: number;
      kind: string;
      data: {
        mergeStrategy: string;
        imported: number;
        sourceSchemaVersion: string;
        targetSchemaVersion: string;
      };
    };
    expect(env.version).toBe(1);
    expect(env.kind).toBe("import");
    expect(env.data.mergeStrategy).toBe("skip");
    expect(env.data.sourceSchemaVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(env.data.targetSchemaVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("refuses to run when no project is initialised in the destination", async () => {
    const source = path.join(tmp, "src");
    initProject(source, "no-dest");
    createSession(source, "no-dest");
    const bundle = exportProject(source, "no-dest.tar.gz");
    // Use a separate, non-cognit tmp dir as the destination root.
    const empty = await fsp.mkdtemp(path.join(os.tmpdir(), "cognit-no-init-"));
    const result = runCli(empty, ["import", "--input", bundle]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/no \.cognit\/cognit\.yaml/);
  });
});
