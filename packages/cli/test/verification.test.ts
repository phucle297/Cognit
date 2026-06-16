import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import BetterSqlite3 from "better-sqlite3";

const CLI_ENTRY = path.resolve(__dirname, "..", "src", "index.ts");
const TSX = path.resolve(__dirname, "..", "node_modules", ".bin", "tsx");

function runCli(cwd: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(TSX, [CLI_ENTRY, ...args], {
    cwd,
    encoding: "utf8",
  });
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
): Array<{
  id: string;
  type: string;
  payload_json: string;
  parent_verification_id: string | null;
  linked_hypothesis_id: string | null;
}> {
  return db
    .prepare(
      "SELECT id, type, payload_json, parent_verification_id, linked_hypothesis_id FROM events WHERE session_id = ? AND type = ? ORDER BY created_at ASC",
    )
    .all(sessionId, type) as Array<{
    id: string;
    type: string;
    payload_json: string;
    parent_verification_id: string | null;
    linked_hypothesis_id: string | null;
  }>;
}

function bootstrap(tmpRoot: string, goal: string): string {
  expect(runCli(tmpRoot, ["init", "--project", "demo"]).status).toBe(0);
  const create = runCli(tmpRoot, ["session", "create", goal]);
  expect(create.status).toBe(0);
  const idMatch = create.stdout.match(/session:\s+(01[A-Z0-9]+)/i);
  expect(idMatch).not.toBeNull();
  return idMatch![1]!;
}

/**
 * Inject a `verification_started` row directly via the explicit
 * subprocess-driven `cognit verify <cmd>` happy path, then return the
 * id of that row. Used by tests that need a parent verification id to
 * point pass/fail/error/rerun at.
 *
 * The driver command (`node -e "process.exit(0)"`) is intentionally
 * deterministic — it always exits 0, so the engine writes both
 * `verification_started` and `verification_passed` events. The
 * `started` row is the one tests want as the parent.
 */
function setupStartedVerification(tmpRoot: string): { sessionId: string; verificationId: string } {
  const sessionId = bootstrap(tmpRoot, "verify-injection");
  // The `--` separator hands everything after it to the verify engine
  // as the command to spawn. Without `--`, commander would try to
  // parse `-e` as a verify option.
  const out = runCli(tmpRoot, [
    "verify",
    "--type",
    "exec",
    "--session",
    sessionId,
    "--",
    "node",
    "-e",
    "process.exit(0)",
  ]);
  expect(out.status).toBe(0);
  const db = openDb(tmpRoot);
  try {
    const rows = eventsOfType(db, sessionId, "verification_started");
    expect(rows.length).toBeGreaterThanOrEqual(1);
    return { sessionId, verificationId: rows[0]!.id };
  } finally {
    db.close();
  }
}

let tmp: string;

beforeEach(async () => {
  tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "cognit-verification-cli-"));
});

afterEach(async () => {
  await fs.promises.rm(tmp, { recursive: true, force: true });
});

describe("cognit verify", () => {
  it("start auto-runs the subprocess and emits started + passed events", async () => {
    const sessionId = bootstrap(tmp, "verify the build");
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
    expect(result.stdout).toContain("type:     verification_started");
    expect(result.stdout).toContain("type:     verification_passed");
    expect(result.stdout).toContain(`session:  ${sessionId}`);

    const db = openDb(tmp);
    try {
      const started = eventsOfType(db, sessionId, "verification_started");
      expect(started).toHaveLength(1);
      const startedPayload = JSON.parse(started[0]!.payload_json) as {
        command: string;
        type: string;
        linked_hypothesis_id: string | null;
      };
      expect(startedPayload.command).toBe("node -e process.stdout.write('hi')");
      expect(startedPayload.type).toBe("test");

      const passed = eventsOfType(db, sessionId, "verification_passed");
      expect(passed).toHaveLength(1);
      expect(passed[0]!.parent_verification_id).toBe(started[0]!.id);
      const passedPayload = JSON.parse(passed[0]!.payload_json) as {
        exit_code: number;
        stdout_excerpt: string | null;
        duration_ms: number | null;
        created_artifact_id: string | null;
      };
      expect(passedPayload.exit_code).toBe(0);
      expect(passedPayload.stdout_excerpt).toBe("hi");
    } finally {
      db.close();
    }
  });

  it("start with a non-zero exit emits started + failed events", async () => {
    const sessionId = bootstrap(tmp, "verify the build");
    const result = runCli(tmp, [
      "verify",
      "--type",
      "exec",
      "--session",
      sessionId,
      "--",
      "node",
      "-e",
      "process.stderr.write('boom'); process.exit(2)",
    ]);
    expect(result.status).toBe(0);
    const db = openDb(tmp);
    try {
      const started = eventsOfType(db, sessionId, "verification_started");
      const failed = eventsOfType(db, sessionId, "verification_failed");
      expect(started).toHaveLength(1);
      expect(failed).toHaveLength(1);
      expect(failed[0]!.parent_verification_id).toBe(started[0]!.id);
      const failPayload = JSON.parse(failed[0]!.payload_json) as {
        stderr_excerpt: string;
        exit_code: number;
      };
      expect(failPayload.stderr_excerpt).toContain("boom");
      expect(failPayload.exit_code).toBe(2);
    } finally {
      db.close();
    }
  });

  it("start with a missing binary emits started + errored events with error_code=enoent", async () => {
    const sessionId = bootstrap(tmp, "verify the build");
    const result = runCli(tmp, [
      "verify",
      "--type",
      "exec",
      "--session",
      sessionId,
      "no-such-command-xyz-12345",
    ]);
    // The engine maps ENOENT to verification_errored; the CLI exits 0
    // because the lifecycle event was successfully recorded.
    expect(result.status).toBe(0);
    const db = openDb(tmp);
    try {
      const errored = eventsOfType(db, sessionId, "verification_errored");
      expect(errored).toHaveLength(1);
      const payload = JSON.parse(errored[0]!.payload_json) as {
        error: string;
        error_code?: string;
      };
      expect(payload.error_code).toBe("enoent");
      expect(payload.error).toMatch(/ENOENT|spawn/i);
    } finally {
      db.close();
    }
  });

  // ===========================================================================
  // verify pass / fail / error / rerun — explicit injection subcommands
  // ===========================================================================
  it("verify pass <vid> emits verification_passed with the supplied outcome fields", async () => {
    const { sessionId, verificationId } = setupStartedVerification(tmp);
    const out = runCli(tmp, [
      "verify",
      "pass",
      verificationId,
      "--exit-code",
      "0",
      "--duration-ms",
      "100",
      "--stdout-excerpt",
      "manual ok",
      "--session",
      sessionId,
    ]);
    expect(out.status).toBe(0);
    expect(out.stdout).toContain("type:     verification_passed");

    const db = openDb(tmp);
    try {
      const passed = eventsOfType(db, sessionId, "verification_passed");
      // Two: one from the bootstrap auto-run, one from this manual pass.
      const manual = passed.find((p) => p.parent_verification_id === verificationId);
      const manualParents = passed.filter((p) => p.parent_verification_id === verificationId);
      expect(manualParents.length).toBeGreaterThanOrEqual(1);
      // Find the row with "manual ok" excerpt.
      const row = passed.find((p) => p.payload_json.includes("manual ok"));
      expect(row).toBeDefined();
      expect(row!.parent_verification_id).toBe(verificationId);
      const payload = JSON.parse(row!.payload_json) as {
        exit_code: number;
        duration_ms: number | null;
        stdout_excerpt: string;
      };
      expect(payload.exit_code).toBe(0);
      expect(payload.duration_ms).toBe(100);
      expect(payload.stdout_excerpt).toBe("manual ok");
      void manual;
    } finally {
      db.close();
    }
  });

  it("verify fail <vid> emits verification_failed with required stderr_excerpt", async () => {
    const { sessionId, verificationId } = setupStartedVerification(tmp);
    const out = runCli(tmp, [
      "verify",
      "fail",
      verificationId,
      "--stderr-excerpt",
      "compile error: foo",
      "--exit-code",
      "1",
      "--session",
      sessionId,
    ]);
    expect(out.status).toBe(0);
    expect(out.stdout).toContain("type:     verification_failed");

    const db = openDb(tmp);
    try {
      const failed = eventsOfType(db, sessionId, "verification_failed");
      const row = failed.find((f) => f.parent_verification_id === verificationId);
      expect(row).toBeDefined();
      const payload = JSON.parse(row!.payload_json) as {
        stderr_excerpt: string;
        exit_code: number | null;
      };
      expect(payload.stderr_excerpt).toBe("compile error: foo");
      expect(payload.exit_code).toBe(1);
    } finally {
      db.close();
    }
  });

  it("verify fail <vid> rejects missing --stderr-excerpt", async () => {
    const { sessionId, verificationId } = setupStartedVerification(tmp);
    const out = runCli(tmp, ["verify", "fail", verificationId, "--session", sessionId]);
    expect(out.status).not.toBe(0);
    expect(out.stderr).toMatch(/stderr-excerpt/);
  });

  it("verify error <vid> emits verification_errored with --error and --error-code", async () => {
    const { sessionId, verificationId } = setupStartedVerification(tmp);
    const out = runCli(tmp, [
      "verify",
      "error",
      verificationId,
      "--error",
      "spawn ENOENT",
      "--error-code",
      "enoent",
      "--duration-ms",
      "5",
      "--session",
      sessionId,
    ]);
    expect(out.status).toBe(0);
    expect(out.stdout).toContain("type:     verification_errored");

    const db = openDb(tmp);
    try {
      const errored = eventsOfType(db, sessionId, "verification_errored");
      const row = errored.find((e) => e.parent_verification_id === verificationId);
      expect(row).toBeDefined();
      const payload = JSON.parse(row!.payload_json) as {
        error: string;
        error_code?: string;
        duration_ms: number | null;
      };
      expect(payload.error).toBe("spawn ENOENT");
      expect(payload.error_code).toBe("enoent");
      expect(payload.duration_ms).toBe(5);
    } finally {
      db.close();
    }
  });

  it("verify rerun <parent-vid> chains a fresh verification_rerun row linking parent", async () => {
    const { sessionId, verificationId } = setupStartedVerification(tmp);
    const out = runCli(tmp, [
      "verify",
      "rerun",
      verificationId,
      "--duration-ms",
      "42",
      "--session",
      sessionId,
    ]);
    expect(out.status).toBe(0);
    expect(out.stdout).toContain("type:     verification_rerun");

    const db = openDb(tmp);
    try {
      const rerun = eventsOfType(db, sessionId, "verification_rerun");
      expect(rerun).toHaveLength(1);
      expect(rerun[0]!.parent_verification_id).toBe(verificationId);
      const payload = JSON.parse(rerun[0]!.payload_json) as {
        parent_verification_id: string;
        duration_ms: number | null;
      };
      expect(payload.parent_verification_id).toBe(verificationId);
      expect(payload.duration_ms).toBe(42);
    } finally {
      db.close();
    }
  });

  // ===========================================================================
  // --json envelope coverage
  // ===========================================================================
  it("--json verify pass returns a parseable envelope", async () => {
    const { sessionId, verificationId } = setupStartedVerification(tmp);
    const out = runCli(tmp, [
      "--json",
      "verify",
      "pass",
      verificationId,
      "--exit-code",
      "0",
      "--session",
      sessionId,
    ]);
    expect(out.status).toBe(0);
    const env = JSON.parse(out.stdout) as {
      kind?: string;
      type?: string;
      data?: { event: { id: string; type: string; parent_verification_id: string | null } };
    };
    const payloadEvent =
      (env.data?.event as { id: string; type: string; parent_verification_id: string | null }) ??
      undefined;
    expect(payloadEvent).toBeDefined();
    expect(payloadEvent!.type).toBe("verification_passed");
    expect(payloadEvent!.parent_verification_id).toBe(verificationId);
  });

  // ===========================================================================
  // session show surfaces verifications
  // ===========================================================================
  it("session show reflects the verification state + stdout_excerpt", async () => {
    const sessionId = bootstrap(tmp, "show verifications");
    const runOut = runCli(tmp, [
      "verify",
      "--type",
      "exec",
      "--session",
      sessionId,
      "--",
      "node",
      "-e",
      "process.stdout.write('hi-show')",
    ]);
    expect(runOut.status).toBe(0);

    // The JSON envelope's `state.verifications` is a ReadonlyMap, which
    // serialises to `{}` (no own enumerable keys). We therefore assert
    // the timeline (events array) shows the started+passed pair, and
    // rely on the human-readable mode below to assert the state map is
    // populated.
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
      stdout_excerpt: string;
      exit_code: number;
    };
    expect(passedPayload.exit_code).toBe(0);
    expect(passedPayload.stdout_excerpt).toBe("hi-show");

    // Human-readable mode includes the Verifications section with the
    // state + excerpt visible. This is the surface the AC explicitly
    // calls out ("session show lists verification with state +
    // stdout_excerpt").
    const showHuman = runCli(tmp, ["session", "show", sessionId]);
    expect(showHuman.status).toBe(0);
    expect(showHuman.stdout).toMatch(/Verifications/);
    expect(showHuman.stdout).toContain("passed");
    expect(showHuman.stdout).toContain("hi-show");
  });
});
