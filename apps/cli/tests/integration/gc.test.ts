import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { runCli } from "../helpers/run-cli";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import BetterSqlite3 from "better-sqlite3";
import YAML from "yaml";

interface CliResult {
  status: number;
  stdout: string;
  stderr: string;
}
let tmp: string;

beforeEach(async () => {
  tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "cognit-gc-"));
});

afterEach(async () => {
  await fs.promises.rm(tmp, { recursive: true, force: true });
});

const initProject = (cleanup: Record<string, unknown>): void => {
  expect(runCli(tmp, ["init", "--project", "gc-demo"]).status).toBe(0);
  // Patch cognit.yaml with the supplied cleanup config. We keep this
  // explicit so the test is self-contained: the default config
  // (artifact_max_age_days: 30) is the production baseline; each
  // test chooses its own threshold and action.
  const cfgPath = path.join(tmp, ".cognit", "cognit.yaml");
  const current = YAML.parse(fs.readFileSync(cfgPath, "utf8"));
  current.cleanup = cleanup;
  fs.writeFileSync(cfgPath, YAML.stringify(current));
};

const seedArtifact = (row: {
  id: string;
  sessionId: string;
  path: string;
  daysOld: number;
}): void => {
  const dbPath = path.join(tmp, ".cognit", "cognit.db");
  const db = new BetterSqlite3(dbPath);
  try {
    db.pragma("foreign_keys = ON");
    // The test bypasses the event-store chokepoint; we just need
    // a project + session so the artifacts FK is satisfied.
    db.prepare(
      `INSERT OR IGNORE INTO projects (id, name, created_at) VALUES (?, ?, ?)`,
    ).run("01projectxxxxxxxxxxxxxxxxx", "gc-demo", new Date().toISOString());
    db.prepare(
      `INSERT OR IGNORE INTO sessions (id, project_id, goal, status, created_at) VALUES (?, ?, ?, ?, ?)`,
    ).run(
      row.sessionId,
      "01projectxxxxxxxxxxxxxxxxx",
      "t",
      "active",
      new Date().toISOString(),
    );
    const createdAt = new Date(Date.now() - row.daysOld * 24 * 60 * 60 * 1000).toISOString();
    db.prepare(
      `INSERT INTO artifacts (id, session_id, path, kind, sha256, size_bytes, archived_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
    ).run(row.id, row.sessionId, row.path, "log", "abc", 1, createdAt);
  } finally {
    db.close();
  }
};

const getRow = (id: string): { archived_at: string | null; path: string } | undefined => {
  const dbPath = path.join(tmp, ".cognit", "cognit.db");
  const db = new BetterSqlite3(dbPath, { readonly: true });
  try {
    return db.prepare(`SELECT archived_at, path FROM artifacts WHERE id = ?`).get(id) as
      | { archived_at: string | null; path: string }
      | undefined;
  } finally {
    db.close();
  }
};

describe("cognit gc", () => {
  it("--dry-run prints candidates without mutating files or rows", () => {
    initProject({ artifact_max_age_days: 7, unreferenced_action: "archive", max_db_size_mb: 1024 });
    // Lay down the on-disk artifact file too so we can verify it
    // was NOT moved during dry-run.
    const artifactPath = path.join(tmp, ".cognit", "artifacts", "stale.log");
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, "stale");
    seedArtifact({ id: "01staleexxxxxxxxxxxxxxxxxx", sessionId: "01sxxxxxxxxxxxxxxxxxxxxxx", path: ".cognit/artifacts/stale.log", daysOld: 30 });

    const result = runCli(tmp, ["gc", "--dry-run", "--force"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/candidates:\s+1/);
    expect(result.stdout).toMatch(/01staleexxxxxxxxxxxxxxxxxx/);
    // No file move.
    expect(fs.existsSync(artifactPath)).toBe(true);
    expect(fs.existsSync(path.join(tmp, ".cognit", "archive", "stale.log"))).toBe(false);
    // No column update.
    const row = getRow("01staleexxxxxxxxxxxxxxxxxx");
    expect(row?.archived_at).toBeNull();
  });

  it("--force skips the confirm prompt and applies the action", () => {
    initProject({ artifact_max_age_days: 7, unreferenced_action: "archive", max_db_size_mb: 1024 });
    const artifactPath = path.join(tmp, ".cognit", "artifacts", "stale.log");
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, "stale");
    seedArtifact({ id: "01staleexxxxxxxxxxxxxxxxxx", sessionId: "01sxxxxxxxxxxxxxxxxxxxxxx", path: ".cognit/artifacts/stale.log", daysOld: 30 });

    const result = runCli(tmp, ["gc", "--force"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/archived:\s+1/);
    // File moved.
    expect(fs.existsSync(artifactPath)).toBe(false);
    expect(fs.existsSync(path.join(tmp, ".cognit", "archive", "stale.log"))).toBe(true);
    // Row flagged.
    const row = getRow("01staleexxxxxxxxxxxxxxxxxx");
    expect(row?.archived_at).not.toBeNull();
  });

  it("rejects 'n' on the confirm prompt (no-op)", () => {
    initProject({ artifact_max_age_days: 7, unreferenced_action: "archive", max_db_size_mb: 1024 });
    const artifactPath = path.join(tmp, ".cognit", "artifacts", "stale.log");
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, "stale");
    seedArtifact({ id: "01staleexxxxxxxxxxxxxxxxxx", sessionId: "01sxxxxxxxxxxxxxxxxxxxxxx", path: ".cognit/artifacts/stale.log", daysOld: 30 });

    const result = runCli(tmp, ["gc"], "n\n");
    expect(result.status).toBe(0);
    expect(fs.existsSync(artifactPath)).toBe(true);
    expect(getRow("01staleexxxxxxxxxxxxxxxxxx")?.archived_at).toBeNull();
  });

  it("action=archive moves file and sets archived_at", () => {
    initProject({ artifact_max_age_days: 7, unreferenced_action: "archive", max_db_size_mb: 1024 });
    const artifactPath = path.join(tmp, ".cognit", "artifacts", "a.log");
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, "a");
    seedArtifact({ id: "01aarchivexxxxxxxxxxxxxxxxx", sessionId: "01sxxxxxxxxxxxxxxxxxxxxxx", path: ".cognit/artifacts/a.log", daysOld: 30 });

    const result = runCli(tmp, ["gc", "--force"]);
    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(tmp, ".cognit", "archive", "a.log"))).toBe(true);
    expect(getRow("01aarchivexxxxxxxxxxxxxxxxx")?.archived_at).not.toBeNull();
  });

  it("action=delete removes file and row", () => {
    initProject({ artifact_max_age_days: 7, unreferenced_action: "delete", max_db_size_mb: 1024 });
    const artifactPath = path.join(tmp, ".cognit", "artifacts", "d.log");
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, "d");
    seedArtifact({ id: "01deleteexxxxxxxxxxxxxxxxx", sessionId: "01sxxxxxxxxxxxxxxxxxxxxxx", path: ".cognit/artifacts/d.log", daysOld: 30 });

    const result = runCli(tmp, ["gc", "--force"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/deleted:\s+1/);
    expect(fs.existsSync(artifactPath)).toBe(false);
    expect(getRow("01deleteexxxxxxxxxxxxxxxxx")).toBeUndefined();
  });

  it("action=keep no-ops: file stays, archived_at stays null", () => {
    initProject({ artifact_max_age_days: 7, unreferenced_action: "keep", max_db_size_mb: 1024 });
    const artifactPath = path.join(tmp, ".cognit", "artifacts", "k.log");
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, "k");
    seedArtifact({ id: "01keepexxxxxxxxxxxxxxxxxx", sessionId: "01sxxxxxxxxxxxxxxxxxxxxxx", path: ".cognit/artifacts/k.log", daysOld: 30 });

    const result = runCli(tmp, ["gc", "--force"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/kept:\s+1/);
    expect(fs.existsSync(artifactPath)).toBe(true);
    expect(getRow("01keepexxxxxxxxxxxxxxxxxx")?.archived_at).toBeNull();
  });

  it("warns at ≥80% db size, hard-stops at ≥100%", () => {
    // max_db_size_mb = 1 so even the tiny seed DB will exceed 100%.
    initProject({ artifact_max_age_days: 7, unreferenced_action: "archive", max_db_size_mb: 1 });
    // Pad the DB so page_count * page_size > 1 MiB.
    const dbPath = path.join(tmp, ".cognit", "cognit.db");
    const db = new BetterSqlite3(dbPath);
    try {
      db.exec(`CREATE TABLE pad (b BLOB)`);
      const stmt = db.prepare(`INSERT INTO pad (b) VALUES (?)`);
      const chunk = Buffer.alloc(4096, "x");
      for (let i = 0; i < 512; i++) stmt.run(chunk);
    } finally {
      db.close();
    }
    const result = runCli(tmp, ["gc", "--force"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/refusing to gc/);
  });

  it("--max-age-days overrides cleanup.artifact_max_age_days", () => {
    initProject({ artifact_max_age_days: 30, unreferenced_action: "archive", max_db_size_mb: 1024 });
    const artifactPath = path.join(tmp, ".cognit", "artifacts", "r.log");
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, "r");
    // 5 days old, but the config threshold is 30. Override to 1 so
    // the row qualifies.
    seedArtifact({ id: "01recentexxxxxxxxxxxxxxxxx", sessionId: "01sxxxxxxxxxxxxxxxxxxxxxx", path: ".cognit/artifacts/r.log", daysOld: 5 });

    const result = runCli(tmp, ["gc", "--force", "--max-age-days", "1"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/archived:\s+1/);
  });

  it("--dry-run does NOT hard-stop on oversized DB (just lists)", () => {
    initProject({ artifact_max_age_days: 7, unreferenced_action: "archive", max_db_size_mb: 1 });
    const dbPath = path.join(tmp, ".cognit", "cognit.db");
    const db = new BetterSqlite3(dbPath);
    try {
      db.exec(`CREATE TABLE pad (b BLOB)`);
      const stmt = db.prepare(`INSERT INTO pad (b) VALUES (?)`);
      const chunk = Buffer.alloc(4096, "x");
      for (let i = 0; i < 512; i++) stmt.run(chunk);
    } finally {
      db.close();
    }
    // Without --dry-run this would exit 1. With --dry-run we still
    // print the candidate set so the user can decide.
    const result = runCli(tmp, ["gc", "--dry-run", "--force"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/candidates:\s+0/);
  });

  it("rejects --max-age-days=NaN", () => {
    initProject({ artifact_max_age_days: 7, unreferenced_action: "archive", max_db_size_mb: 1024 });
    const result = runCli(tmp, ["gc", "--dry-run", "--force", "--max-age-days", "abc"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/--max-age-days/);
  });

  it("emits a JSON envelope with --json", () => {
    initProject({ artifact_max_age_days: 7, unreferenced_action: "archive", max_db_size_mb: 1024 });
    const result = runCli(tmp, ["gc", "--json", "--dry-run", "--force"]);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.version).toBe(1);
    expect(parsed.kind).toBe("gc");
    expect(parsed.data.action).toBe("archive");
    expect(parsed.data.dryRun).toBe(true);
    expect(typeof parsed.data.dbSizeBytes).toBe("number");
  });
});
