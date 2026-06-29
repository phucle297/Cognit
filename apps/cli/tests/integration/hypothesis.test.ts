import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { runCli } from "../helpers/run-cli";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import BetterSqlite3 from "better-sqlite3";

let tmp: string;

beforeEach(async () => {
  tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "cognit-hypothesis-cli-"));
});

afterEach(async () => {
  await fs.promises.rm(tmp, { recursive: true, force: true });
});

describe("cognit hypothesis", () => {
  it("propose appends a hypothesis_created event with the typed payload", async () => {
    expect(runCli(tmp, ["init", "--project", "demo"]).status).toBe(0);
    const create = runCli(tmp, ["session", "create", "explore a hypothesis"]);
    expect(create.status).toBe(0);
    const idMatch = create.stdout.match(/session:\s+(01[A-Z0-9]+)/i);
    expect(idMatch).not.toBeNull();
    const sessionId = idMatch![1]!;

    const propose = runCli(tmp, [
      "hypothesis",
      "propose",
      "NPE root cause",
      "--text",
      "we believe the UserService hits a null pointer when the session cache is empty",
      "--session",
      sessionId,
      "--confidence",
      "0.7",
    ]);
    expect(propose.status).toBe(0);
    expect(propose.stdout).toMatch(/event:\s+01[A-Z0-9]+/i);
    expect(propose.stdout).toContain("type:     hypothesis_created");
    expect(propose.stdout).toContain(`session:  ${sessionId}`);
    expect(propose.stdout).toMatch(/time:\s+\d{4}-\d{2}-\d{2}T/);

    // Open the DB directly and assert exactly one hypothesis_created
    // event with the expected payload.
    const dbPath = path.join(tmp, ".cognit", "cognit.db");
    const db = new BetterSqlite3(dbPath, { readonly: true });
    try {
      const rows = db
        .prepare(
          "SELECT id, type, payload_json, confidence FROM events WHERE session_id = ? AND type = ? ORDER BY created_at ASC",
        )
        .all(sessionId, "hypothesis_created") as Array<{
        id: string;
        type: string;
        payload_json: string;
        confidence: number | null;
      }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.type).toBe("hypothesis_created");
      const payload = JSON.parse(rows[0]!.payload_json) as {
        title: string;
        text: string;
      };
      expect(payload.title).toBe("NPE root cause");
      expect(payload.text).toBe(
        "we believe the UserService hits a null pointer when the session cache is empty",
      );
      expect(rows[0]!.confidence).toBeCloseTo(0.7, 5);
    } finally {
      db.close();
    }
  });
});
