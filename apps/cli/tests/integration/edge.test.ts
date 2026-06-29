import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { runCli } from "../helpers/run-cli";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import BetterSqlite3 from "better-sqlite3";

let tmp: string;

beforeEach(async () => {
  tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "cognit-edge-cli-"));
});

afterEach(async () => {
  await fs.promises.rm(tmp, { recursive: true, force: true });
});

describe("cognit edge add", () => {
  it("appends an edge_created event with the typed payload", async () => {
    expect(runCli(tmp, ["init", "--project", "demo"]).status).toBe(0);
    const create = runCli(tmp, ["session", "create", "watch edges"]);
    expect(create.status).toBe(0);
    const idMatch = create.stdout.match(/session:\s+(01[A-Z0-9]+)/i);
    expect(idMatch).not.toBeNull();
    const sessionId = idMatch![1]!;

    const add = runCli(tmp, [
      "edge",
      "add",
      "--from-type",
      "conclusion",
      "--from-id",
      "01CONC00000000000000000000",
      "--to-type",
      "decision",
      "--to-id",
      "01DECI00000000000000000000",
      "--kind",
      "supports",
      "--session",
      sessionId,
    ]);
    expect(add.status).toBe(0);
    expect(add.stdout).toMatch(/event:\s+01[A-Z0-9]+/i);
    expect(add.stdout).toContain("type:     edge_created");
    expect(add.stdout).toContain(`session:  ${sessionId}`);
    expect(add.stdout).toMatch(/time:\s+\d{4}-\d{2}-\d{2}T/);
    expect(add.stdout).toContain(
      "edge:     conclusion:01CONC00000000000000000000 --supports--> decision:01DECI00000000000000000000",
    );

    // Open the DB directly and assert exactly one edge_created event
    // with the expected payload.
    const dbPath = path.join(tmp, ".cognit", "cognit.db");
    const db = new BetterSqlite3(dbPath, { readonly: true });
    try {
      const rows = db
        .prepare(
          "SELECT id, type, payload_json FROM events WHERE session_id = ? AND type = ? ORDER BY created_at ASC",
        )
        .all(sessionId, "edge_created") as Array<{
        id: string;
        type: string;
        payload_json: string;
      }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.type).toBe("edge_created");
      const payload = JSON.parse(rows[0]!.payload_json) as {
        edge_type: string;
        from_entity_type: string;
        from_entity_id: string;
        to_entity_type: string;
        to_entity_id: string;
      };
      expect(payload).toEqual({
        edge_type: "supports",
        from_entity_type: "conclusion",
        from_entity_id: "01CONC00000000000000000000",
        to_entity_type: "decision",
        to_entity_id: "01DECI00000000000000000000",
      });
    } finally {
      db.close();
    }
  });
});
