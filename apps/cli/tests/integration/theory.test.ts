import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { runCli } from "../helpers/run-cli";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import BetterSqlite3 from "better-sqlite3";

let tmp: string;

beforeEach(async () => {
  tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "cognit-theory-cli-"));
});

afterEach(async () => {
  await fs.promises.rm(tmp, { recursive: true, force: true });
});

describe("cognit theory add", () => {
  it("appends a theory_created event with the typed payload", async () => {
    expect(runCli(tmp, ["init", "--project", "demo"]).status).toBe(0);
    const create = runCli(tmp, ["session", "create", "track theories"]);
    expect(create.status).toBe(0);
    const idMatch = create.stdout.match(/session:\s+(01[A-Z0-9]+)/i);
    expect(idMatch).not.toBeNull();
    const sessionId = idMatch![1]!;

    const theory = runCli(tmp, [
      "theory",
      "add",
      "Two-phase commit",
      "--text",
      "coordinator + cohort",
      "--session",
      sessionId,
    ]);
    expect(theory.status).toBe(0);
    expect(theory.stdout).toMatch(/event:\s+01[A-Z0-9]+/i);
    expect(theory.stdout).toContain("type:     theory_created");
    expect(theory.stdout).toContain(`session:  ${sessionId}`);
    expect(theory.stdout).toMatch(/time:\s+\d{4}-\d{2}-\d{2}T/);

    // Open the DB directly and assert exactly one theory_created event
    // with the expected payload.
    const dbPath = path.join(tmp, ".cognit", "cognit.db");
    const db = new BetterSqlite3(dbPath, { readonly: true });
    try {
      const rows = db
        .prepare(
          "SELECT id, type, payload_json FROM events WHERE session_id = ? AND type = ? ORDER BY created_at ASC",
        )
        .all(sessionId, "theory_created") as Array<{
        id: string;
        type: string;
        payload_json: string;
      }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.type).toBe("theory_created");
      const payload = JSON.parse(rows[0]!.payload_json) as { title: string; text: string };
      expect(payload.title).toBe("Two-phase commit");
      expect(payload.text).toBe("coordinator + cohort");
    } finally {
      db.close();
    }
  });
});
