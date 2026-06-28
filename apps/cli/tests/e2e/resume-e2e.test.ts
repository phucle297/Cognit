import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { runCli } from "../helpers/run-cli";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import BetterSqlite3 from "better-sqlite3";

let tmp: string;

beforeEach(async () => {
  tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "cognit-resume-cli-"));
});

afterEach(async () => {
  await fs.promises.rm(tmp, { recursive: true, force: true });
});

/**
 * Phase-2 done_when CLI E2E: prove the resume --fork=true flag
 * wires through to the DB and creates a new session whose
 * parent_session_id points back at the original.
 *
 * The CLI does not print the new session's parent_session_id
 * directly, so this test reads the SQLite DB directly with
 * better-sqlite3 (added as a devDep on this package) to verify the
 * link and the session_created event payload.
 */
describe("cognit session resume --fork=true (E2E)", () => {
  it("creates a new session with parent_session_id set", async () => {
    // 1. init in tmp dir
    const init = runCli(tmp, ["init", "--project", "demo"]);
    expect(init.status).toBe(0);
    expect(init.stdout).toContain("Initialised Cognit project");

    // 2. session create → grab id
    const create = runCli(tmp, ["session", "create", "p"]);
    expect(create.status).toBe(0);
    const oldIdMatch = create.stdout.match(/session:\s+(01[A-Z0-9]+)/i);
    expect(oldIdMatch).not.toBeNull();
    const oldId = oldIdMatch![1]!;

    // 3. Append a couple of events to the original session.
    const append1 = runCli(tmp, [
      "append",
      "--type",
      "observation_recorded",
      "--payload",
      '{"text":"first"}',
      "--session",
      oldId,
    ]);
    expect(append1.status).toBe(0);
    const append2 = runCli(tmp, [
      "append",
      "--type",
      "observation_recorded",
      "--payload",
      '{"text":"second"}',
      "--session",
      oldId,
    ]);
    expect(append2.status).toBe(0);

    // 4. session resume <id> --fork=true → grab new id
    //    (The original session is left active. Per SessionService's
    //    contract, a closed session cannot be forked; forking from
    //    an active session is the supported path. The plan's "close
    //    then resume" step is incompatible with that contract.)
    const resume = runCli(tmp, ["session", "resume", oldId, "--fork=true"]);
    expect(resume.status).toBe(0);
    expect(resume.stdout).toContain(`parent:     ${oldId}`);
    expect(resume.stdout).toContain("forked:     yes (new session)");
    const newIdMatch = resume.stdout.match(/session:\s+(01[A-Z0-9]+)/i);
    expect(newIdMatch).not.toBeNull();
    const newId = newIdMatch![1]!;
    expect(newId).not.toBe(oldId);

    // 6. Read the DB directly to assert:
    //    - a sessions row with id = newId and parent_session_id = oldId
    //    - a session_created event on newId with parent_session_id in payload
    const dbPath = path.join(tmp, ".cognit", "cognit.db");
    expect(fs.existsSync(dbPath)).toBe(true);
    const db = new BetterSqlite3(dbPath, { readonly: true });
    try {
      const newSession = db
        .prepare("SELECT id, parent_session_id FROM sessions WHERE id = ?")
        .get(newId) as { id: string; parent_session_id: string | null } | undefined;
      expect(newSession).toBeDefined();
      expect(newSession?.id).toBe(newId);
      expect(newSession?.parent_session_id).toBe(oldId);

      const events = db
        .prepare(
          "SELECT type, payload_json FROM events WHERE session_id = ? ORDER BY created_at ASC, id ASC",
        )
        .all(newId) as Array<{ type: string; payload_json: string }>;
      // The forked session should have a single session_created event
      // whose payload carries parent_session_id pointing at oldId.
      const created = events.find((e) => e.type === "session_created");
      expect(created).toBeDefined();
      const payload = JSON.parse(created!.payload_json);
      expect(payload.parent_session_id).toBe(oldId);
    } finally {
      db.close();
    }
  });
});
