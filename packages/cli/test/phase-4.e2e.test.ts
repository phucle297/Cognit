/**
 * packages/cli/test/phase-4.e2e.test.ts — phase 4 acceptance criteria
 * (Cognit-oqd).
 *
 * The full phase 4 plan lands in 12 sub-beads across 4a (verify engine
 * + lifecycle), 4b (redaction test), 4c (gc), 4d (export/import). This
 * file is the AC1 happy-path smoke that proves the verify lifecycle
 * works end-to-end through the CLI. The remaining ACs land with their
 * owning sub-beads.
 *
 * AC1 — `cognit verify <command>` runs end-to-end: emits
 *      `verification_started` → `verification_passed` (or
 *      `_failed`/`_errored`/`_cancelled`), `session show` reflects
 *      the terminal state, `stdout_excerpt` and `exit_code` are
 *      populated, artifacts >1KB are written to
 *      `.cognit/artifacts/<sha256>.log`.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import BetterSqlite3 from "better-sqlite3";

const CLI_ENTRY = path.resolve(__dirname, "..", "src", "index.ts");
const TSX = path.resolve(__dirname, "..", "node_modules", ".bin", "tsx");

function runCli(
  cwd: string,
  args: string[],
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(TSX, [CLI_ENTRY, ...args], { cwd, encoding: "utf8" });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function openDb(tmpRoot: string): BetterSqlite3.Database {
  return new BetterSqlite3(path.join(tmpRoot, ".cognit", "cognit.db"), { readonly: true });
}

function eventsOfType(
  db: BetterSqlite3.Database,
  sessionId: string,
  type: string,
): Array<{ id: string; type: string; payload_json: string; parent_verification_id: string | null }> {
  return db
    .prepare(
      "SELECT id, type, payload_json, parent_verification_id FROM events WHERE session_id = ? AND type = ? ORDER BY created_at ASC",
    )
    .all(sessionId, type) as Array<{
    id: string;
    type: string;
    payload_json: string;
    parent_verification_id: string | null;
  }>;
}

let tmp: string;

beforeEach(async () => {
  tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "cognit-phase4-e2e-"));
});

afterEach(async () => {
  await fs.promises.rm(tmp, { recursive: true, force: true });
});

describe("phase-4 AC1 — cognit verify happy path", () => {
  it("runs a real command end-to-end and emits verification_started → verification_passed", async () => {
    expect(runCli(tmp, ["init", "--project", "demo"]).status).toBe(0);

    const create = runCli(tmp, ["session", "create", "verify-e2e"]);
    expect(create.status).toBe(0);
    const idMatch = create.stdout.match(/session:\s+(01[A-Z0-9]+)/i);
    expect(idMatch).not.toBeNull();
    const sessionId = idMatch![1]!;

    // Run a real command through the verify engine. `--` hands the
    // remaining tokens to the engine as the command to spawn.
    const result = runCli(tmp, [
      "verify",
      "--type",
      "test",
      "--session",
      sessionId,
      "--",
      "node",
      "-e",
      "process.stdout.write('hi')",
    ]);
    expect(result.status).toBe(0);
    // The CLI prints both events in human mode.
    expect(result.stdout).toContain("type:     verification_started");
    expect(result.stdout).toContain("type:     verification_passed");
    expect(result.stdout).toContain(`session:  ${sessionId}`);

    const db = openDb(tmp);
    try {
      // started → passed pair landed in the events table.
      const started = eventsOfType(db, sessionId, "verification_started");
      const passed = eventsOfType(db, sessionId, "verification_passed");
      expect(started).toHaveLength(1);
      expect(passed).toHaveLength(1);
      expect(passed[0]!.parent_verification_id).toBe(started[0]!.id);

      const startedPayload = JSON.parse(started[0]!.payload_json) as {
        command: string;
        type: string;
      };
      expect(startedPayload.command).toBe("node -e process.stdout.write('hi')");
      expect(startedPayload.type).toBe("test");

      const passedPayload = JSON.parse(passed[0]!.payload_json) as {
        exit_code: number;
        stdout_excerpt: string | null;
        duration_ms: number | null;
        created_artifact_id: string | null;
      };
      expect(passedPayload.exit_code).toBe(0);
      expect(passedPayload.stdout_excerpt).toBe("hi");
      expect(passedPayload.duration_ms).not.toBeNull();
      // "hi" is well under the 1KB threshold so no artifact is written.
      expect(passedPayload.created_artifact_id).toBeNull();
    } finally {
      db.close();
    }

    // session show --json timeline surfaces the terminal event.
    const show = runCli(tmp, ["--json", "session", "show", sessionId]);
    expect(show.status).toBe(0);
    const env = JSON.parse(show.stdout) as {
      data?: {
        state?: {
          timeline?: Array<{ type: string; payload_json: string }>;
        };
      };
    };
    const timeline = env.data?.state?.timeline ?? [];
    const passedRow = timeline.find((e) => e.type === "verification_passed");
    expect(passedRow).toBeDefined();
    const passedPayload = JSON.parse(passedRow!.payload_json) as {
      exit_code: number;
      stdout_excerpt: string;
    };
    expect(passedPayload.exit_code).toBe(0);
    expect(passedPayload.stdout_excerpt).toBe("hi");

    // Human mode also shows the Verifications section.
    const showHuman = runCli(tmp, ["session", "show", sessionId]);
    expect(showHuman.status).toBe(0);
    expect(showHuman.stdout).toMatch(/Verifications/);
    expect(showHuman.stdout).toContain("passed");
    expect(showHuman.stdout).toContain("hi");
  });

  it("writes a >1KB artifact to .cognit/artifacts/<sha256>.log and threads the id", async () => {
    expect(runCli(tmp, ["init", "--project", "demo"]).status).toBe(0);
    const create = runCli(tmp, ["session", "create", "verify-artifact"]);
    const sessionId = (create.stdout.match(/session:\s+(01[A-Z0-9]+)/i) ?? [])[1]!;

    // Generate >1KB of stdout via a small node script written under
    // the temp project. Stays hermetic — no shell metachars in argv.
    const scriptPath = path.join(tmp, "big-stdout.js");
    await fs.promises.writeFile(
      scriptPath,
      "for(let i=0;i<200;i++)process.stdout.write('x'.repeat(20));\n",
    );
    const result = runCli(tmp, [
      "verify",
      "--type",
      "exec",
      "--session",
      sessionId,
      "--",
      "node",
      scriptPath,
    ]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("type:     verification_passed");

    const db = openDb(tmp);
    try {
      const passed = eventsOfType(db, sessionId, "verification_passed");
      expect(passed).toHaveLength(1);
      const payload = JSON.parse(passed[0]!.payload_json) as {
        exit_code: number;
        created_artifact_id: string | null;
      };
      expect(payload.exit_code).toBe(0);
      expect(payload.created_artifact_id).not.toBeNull();
      const artifactId = payload.created_artifact_id!;
      expect(artifactId).toMatch(/^[0-9a-f]{64}$/);
      const artifactPath = path.join(tmp, ".cognit", "artifacts", `${artifactId}.log`);
      const stat = await fs.promises.stat(artifactPath);
      expect(stat.size).toBeGreaterThan(1024);
    } finally {
      db.close();
    }
  });
});
