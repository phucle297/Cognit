/**
 * apps/cli/test/export.test.ts — phase 4 / 6bz.9 (cognit export)
 * acceptance test (AC5).
 *
 * AC5 — `cognit export --output bundle.tar.gz [--include-artifacts]`
 *       produces a valid tar.gz with `manifest.json` (format_version
 *       1), `cognit.db` (valid SQLite, VACUUM INTO copy), and
 *       `cognit.yaml`. `--include-artifacts` adds the artifacts/
 *       directory to the bundle.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { extract, list } from "tar";
import BetterSqlite3 from "better-sqlite3";

const CLI_ENTRY = path.resolve(__dirname, "..", "src", "index.ts");
const TSX = path.resolve(__dirname, "..", "node_modules", ".bin", "tsx");

interface CliResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runCli(cwd: string, args: string[]): CliResult {
  const result = spawnSync(TSX, [CLI_ENTRY, ...args], { cwd, encoding: "utf8" });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

const listTarGz = (tarball: string): Promise<string[]> =>
  new Promise((resolve, reject) => {
    const entries: string[] = [];
    // tar@7 list({ file, gzip, onentry }) returns a Promise<void> that
    // resolves once the entire archive has been walked. The onentry
    // callback fires once per entry (regular files and directories).
    list({
      file: tarball,
      gzip: true,
      onentry: (e) => {
        // e.path is the entry path inside the tar (no leading "./")
        // but may include a trailing "/" for directories — we
        // normalise by stripping that.
        const p = e.path.replace(/\/$/, "");
        if (p) entries.push(p);
      },
    })
      .then(() => resolve(entries))
      .catch(reject);
  });

const extractEntry = async (tarball: string, entry: string): Promise<Buffer> => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "cognit-extract-"));
  try {
    await extract({ file: tarball, cwd: dir, gzip: true, filter: (p) => p === entry });
    return await fsp.readFile(path.join(dir, entry));
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
};

let tmp: string;

beforeEach(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "cognit-export-"));
});

afterEach(async () => {
  await fsp.rm(tmp, { recursive: true, force: true });
});

describe("cognit export", () => {
  it("produces a tar.gz with manifest.json, cognit.db, and cognit.yaml", async () => {
    expect(runCli(tmp, ["init", "--project", "export-demo"]).status).toBe(0);
    const out = path.join(tmp, "bundle.tar.gz");
    const result = runCli(tmp, ["export", "--output", out]);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/exported to .*bundle\.tar\.gz/);
    expect(fs.existsSync(out)).toBe(true);

    const entries = await listTarGz(out);
    expect(entries).toEqual(expect.arrayContaining(["manifest.json", "cognit.db", "cognit.yaml"]));
  });

  it("manifest.json is valid JSON with format_version = 1 and the project name", async () => {
    expect(runCli(tmp, ["init", "--project", "export-meta"]).status).toBe(0);
    const out = path.join(tmp, "meta.tar.gz");
    runCli(tmp, ["export", "--output", out]);

    const buf = await extractEntry(out, "manifest.json");
    const manifest = JSON.parse(buf.toString("utf8")) as {
      format_version: number;
      created_at: string;
      project_name: string;
      schema_version: string;
    };
    expect(manifest.format_version).toBe(1);
    expect(manifest.project_name).toBe("export-meta");
    expect(manifest.schema_version).toMatch(/^\d+\.\d+\.\d+$/);
    // ISO-8601 timestamp
    expect(() => new Date(manifest.created_at).toISOString()).not.toThrow();
  });

  it("cognit.db in the bundle is a valid SQLite file that round-trips the local data", async () => {
    expect(runCli(tmp, ["init", "--project", "export-db"]).status).toBe(0);
    // Insert a row we can read back from the bundle.
    const dbPath = path.join(tmp, ".cognit", "cognit.db");
    const src = new BetterSqlite3(dbPath);
    try {
      src.exec(`INSERT OR REPLACE INTO projects (id, name, created_at) VALUES ('01testxxxxxxxxxxxxxxxxxx', 'export-db', '2026-01-01T00:00:00Z')`);
    } finally {
      src.close();
    }
    const out = path.join(tmp, "db.tar.gz");
    runCli(tmp, ["export", "--output", out]);

    const dbBuf = await extractEntry(out, "cognit.db");
    const work = await fsp.mkdtemp(path.join(os.tmpdir(), "cognit-verify-"));
    try {
      const target = path.join(work, "cognit.db");
      await fsp.writeFile(target, dbBuf);
      const verify = new BetterSqlite3(target, { readonly: true });
      try {
        const row = verify
          .prepare(`SELECT name FROM projects WHERE id = ?`)
          .get("01testxxxxxxxxxxxxxxxxxx") as { name: string } | undefined;
        expect(row?.name).toBe("export-db");
        // integrity_check on the exported copy — proves VACUUM INTO
        // produced a clean, self-contained DB.
        const ic = verify.pragma("integrity_check", { simple: true }) as string;
        expect(ic).toBe("ok");
      } finally {
        verify.close();
      }
    } finally {
      await fsp.rm(work, { recursive: true, force: true });
    }
  });

  it("--include-artifacts adds the artifacts/ entry and packs the on-disk files", async () => {
    expect(runCli(tmp, ["init", "--project", "export-artifacts"]).status).toBe(0);
    // Lay down an artifact file (a real file under artifacts/ — we
    // don't need a row, just an on-disk presence).
    const artifactPath = path.join(tmp, ".cognit", "artifacts", "hello.log");
    await fsp.mkdir(path.dirname(artifactPath), { recursive: true });
    await fsp.writeFile(artifactPath, "hello world\n");

    const out = path.join(tmp, "with-artifacts.tar.gz");
    const result = runCli(tmp, ["export", "--output", out, "--include-artifacts"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/artifacts:\s+1 file/);

    const entries = await listTarGz(out);
    expect(entries).toEqual(expect.arrayContaining(["artifacts/hello.log"]));

    // The packed file contents round-trip.
    const buf = await extractEntry(out, "artifacts/hello.log");
    expect(buf.toString("utf8")).toBe("hello world\n");
  });

  it("omits the artifacts/ entry without --include-artifacts (default)", async () => {
    expect(runCli(tmp, ["init", "--project", "no-artifacts"]).status).toBe(0);
    const out = path.join(tmp, "no-art.tar.gz");
    runCli(tmp, ["export", "--output", out]);
    const entries = await listTarGz(out);
    expect(entries.find((e) => e.startsWith("artifacts/"))).toBeUndefined();
  });

  it("refuses to run when no project is initialised", async () => {
    // tmp exists but contains no .cognit/cognit.yaml
    const out = path.join(tmp, "nope.tar.gz");
    const result = runCli(tmp, ["export", "--output", out]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/no \.cognit\/cognit\.yaml/);
  });

  it("emits a stable JSON envelope with --json", async () => {
    expect(runCli(tmp, ["init", "--project", "export-json"]).status).toBe(0);
    const out = path.join(tmp, "json.tar.gz");
    const result = runCli(tmp, ["--json", "export", "--output", out]);
    expect(result.status).toBe(0);
    const env = JSON.parse(result.stdout) as {
      version: number;
      kind: string;
      data: {
        formatVersion: number;
        schemaVersion: string;
        projectName: string;
        bytesWritten: number;
        includeArtifacts: boolean;
        artifactCount: number;
      };
    };
    expect(env.version).toBe(1);
    expect(env.kind).toBe("export");
    expect(env.data.formatVersion).toBe(1);
    expect(env.data.projectName).toBe("export-json");
    expect(env.data.bytesWritten).toBeGreaterThan(0);
    expect(env.data.includeArtifacts).toBe(false);
    expect(env.data.artifactCount).toBe(0);
  });

  it("requires --output (commander rejects when missing)", async () => {
    expect(runCli(tmp, ["init", "--project", "needs-output"]).status).toBe(0);
    const result = runCli(tmp, ["export"]);
    expect(result.status).not.toBe(0);
    // commander writes a usage hint to stderr when --required fails.
    expect(result.stderr).toMatch(/--output/);
  });
});
