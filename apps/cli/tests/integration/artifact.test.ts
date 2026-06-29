import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { runCli } from "../helpers/run-cli";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import BetterSqlite3 from "better-sqlite3";

let tmp: string;

beforeEach(async () => {
  tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "cognit-artifact-cli-"));
});

afterEach(async () => {
  await fs.promises.rm(tmp, { recursive: true, force: true });
});

describe("cognit artifact", () => {
  it("add appends an artifact_attached event with the typed payload", async () => {
    expect(runCli(tmp, ["init", "--project", "demo"]).status).toBe(0);
    const create = runCli(tmp, ["session", "create", "ship a build log"]);
    expect(create.status).toBe(0);
    const idMatch = create.stdout.match(/session:\s+(01[A-Z0-9]+)/i);
    expect(idMatch).not.toBeNull();
    const sessionId = idMatch![1]!;

    const result = runCli(tmp, [
      "artifact",
      "add",
      "--id",
      "01ART0000000000000000000000",
      "--role",
      "log",
      "--session",
      sessionId,
    ]);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/event:\s+01[A-Z0-9]+/i);
    expect(result.stdout).toContain("type:     artifact_attached");
    expect(result.stdout).toContain(`session:  ${sessionId}`);

    const dbPath = path.join(tmp, ".cognit", "cognit.db");
    const db = new BetterSqlite3(dbPath, { readonly: true });
    try {
      const rows = db
        .prepare(
          "SELECT id, type, payload_json FROM events WHERE session_id = ? AND type = ? ORDER BY created_at ASC",
        )
        .all(sessionId, "artifact_attached") as Array<{
        id: string;
        type: string;
        payload_json: string;
      }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.type).toBe("artifact_attached");
      const payload = JSON.parse(rows[0]!.payload_json) as {
        artifact_id: string;
        role: string;
      };
      expect(payload.artifact_id).toBe("01ART0000000000000000000000");
      expect(payload.role).toBe("log");
    } finally {
      db.close();
    }
  });
});
