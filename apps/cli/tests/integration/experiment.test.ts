import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { runCli } from "../helpers/run-cli";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import BetterSqlite3 from "better-sqlite3";

let tmp: string;

beforeEach(async () => {
  tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "cognit-experiment-cli-"));
});

afterEach(async () => {
  await fs.promises.rm(tmp, { recursive: true, force: true });
});

describe("cognit experiment add", () => {
  it("appends an experiment_created event with the typed payload", async () => {
    expect(runCli(tmp, ["init", "--project", "demo"]).status).toBe(0);
    const create = runCli(tmp, ["session", "create", "track experiments"]);
    expect(create.status).toBe(0);
    const idMatch = create.stdout.match(/session:\s+(01[A-Z0-9]+)/i);
    expect(idMatch).not.toBeNull();
    const sessionId = idMatch![1]!;
    // A real hypothesis ULID is required for the schema (string), but
    // the event-store does not validate referential integrity at
    // append time — it just stores the id. The reducer is what
    // cares about the link; this test asserts the append path.
    const fakeHypothesisId = "01HYP000000000000000000000";

    const experiment = runCli(tmp, [
      "experiment",
      "add",
      "--tests-hypothesis",
      fakeHypothesisId,
      "--design",
      "kill coordinator, expect cohort to fail",
      "--session",
      sessionId,
    ]);
    expect(experiment.status).toBe(0);
    expect(experiment.stdout).toMatch(/event:\s+01[A-Z0-9]+/i);
    expect(experiment.stdout).toContain("type:     experiment_created");
    expect(experiment.stdout).toContain(`session:  ${sessionId}`);
    expect(experiment.stdout).toMatch(/time:\s+\d{4}-\d{2}-\d{2}T/);

    // Open the DB directly and assert exactly one experiment_created
    // event with the expected payload.
    const dbPath = path.join(tmp, ".cognit", "cognit.db");
    const db = new BetterSqlite3(dbPath, { readonly: true });
    try {
      const rows = db
        .prepare(
          "SELECT id, type, payload_json FROM events WHERE session_id = ? AND type = ? ORDER BY created_at ASC",
        )
        .all(sessionId, "experiment_created") as Array<{
        id: string;
        type: string;
        payload_json: string;
      }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.type).toBe("experiment_created");
      const payload = JSON.parse(rows[0]!.payload_json) as {
        tests_hypothesis_id: string;
        design: string;
      };
      expect(payload.tests_hypothesis_id).toBe(fakeHypothesisId);
      expect(payload.design).toBe("kill coordinator, expect cohort to fail");
    } finally {
      db.close();
    }
  });
});
