import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { runCli } from "../helpers/run-cli";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import BetterSqlite3 from "better-sqlite3";

let tmp: string;

beforeEach(async () => {
  tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "cognit-conclusion-cli-"));
});

afterEach(async () => {
  await fs.promises.rm(tmp, { recursive: true, force: true });
});

describe("cognit conclusion", () => {
  it("propose appends a conclusion_proposed event with the typed payload", async () => {
    expect(runCli(tmp, ["init", "--project", "demo"]).status).toBe(0);
    const create = runCli(tmp, ["session", "create", "investigate"]);
    expect(create.status).toBe(0);
    const idMatch = create.stdout.match(/session:\s+(01[A-Z0-9]+)/i);
    expect(idMatch).not.toBeNull();
    const sessionId = idMatch![1]!;

    const result = runCli(tmp, [
      "conclusion",
      "propose",
      "use a queue here",
      "--session",
      sessionId,
    ]);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/event:\s+01[A-Z0-9]+/i);
    expect(result.stdout).toContain("type:     conclusion_proposed");
    expect(result.stdout).toContain(`session:  ${sessionId}`);

    // Open the DB directly and assert exactly one conclusion_proposed
    // event with the expected payload.
    const dbPath = path.join(tmp, ".cognit", "cognit.db");
    const db = new BetterSqlite3(dbPath, { readonly: true });
    try {
      const rows = db
        .prepare(
          "SELECT id, type, payload_json FROM events WHERE session_id = ? AND type = ? ORDER BY created_at ASC",
        )
        .all(sessionId, "conclusion_proposed") as Array<{
        id: string;
        type: string;
        payload_json: string;
      }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.type).toBe("conclusion_proposed");
      const payload = JSON.parse(rows[0]!.payload_json) as { text: string };
      expect(payload.text).toBe("use a queue here");
    } finally {
      db.close();
    }
  });
});
