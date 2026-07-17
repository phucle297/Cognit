/**
 * D-M6-00 — cognit raw backfill + export schema_version from DB.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as fssync from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import BetterSqlite3 from "better-sqlite3";
import { runCli } from "../helpers/run-cli.js";

describe("cognit raw backfill (D-M6-00)", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "cognit-raw-bf-"));
    const init = runCli(root, ["init", "--project", "raw-bf"]);
    expect(init.status).toBe(0);

    const dbPath = path.join(root, ".cognit", "cognit.db");
    const db = new BetterSqlite3(dbPath);
    try {
      const project = db.prepare("SELECT id FROM projects LIMIT 1").get() as {
        id: string;
      };
      const sessionId = "01HZZZZZZZZZZZZZZZZZZZZZZ2";
      const eventId = "01HZZZZZZZZZZZZZZZZZZZZZZ3";
      db.prepare(
        `INSERT INTO sessions (id, project_id, parent_session_id, goal, status, last_snapshot_event_id, created_at, closed_at)
         VALUES (?, ?, NULL, 'backfill goal', 'active', NULL, ?, NULL)`,
      ).run(sessionId, project.id, new Date().toISOString());

      const processed = path.join(root, ".cognit", "processed");
      await fs.mkdir(processed, { recursive: true });
      await fs.writeFile(
        path.join(processed, `${eventId}.json`),
        JSON.stringify({
          id: eventId,
          type: "raw_tool_signal",
          version: "1.3.0",
          session_id: sessionId,
          actor_name: "worker",
          actor_type: "worker",
          payload: {
            phase: "post",
            host: "grok",
            tool: "search_replace",
            text: "tool search_replace → /x.ts",
            path: "/x.ts",
            tool_input: { file_path: "/x.ts", old_string: "a", new_string: "b" },
          },
          source: { tool: "search_replace", command: "PostToolUse" },
        }) + "\n",
        "utf8",
      );
    } finally {
      db.close();
    }
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("inserts raw_events from processed JSON", () => {
    const r = runCli(root, ["--json", "raw", "backfill"]);
    expect(r.status).toBe(0);
    const env = JSON.parse(r.stdout.trim()) as {
      data: { inserted: number; scanned: number; skipped_invalid: number };
    };
    expect(env.data.scanned).toBe(1);
    expect(env.data.inserted).toBe(1);

    const db = new BetterSqlite3(path.join(root, ".cognit", "cognit.db"), {
      readonly: true,
    });
    try {
      const row = db
        .prepare("SELECT id, type, domain_event_count FROM raw_events")
        .get() as { id: string; type: string; domain_event_count: number };
      expect(row.id).toBe("01HZZZZZZZZZZZZZZZZZZZZZZ3");
      expect(row.type).toBe("raw_tool_signal");

      const r2 = runCli(root, ["--json", "raw", "backfill"]);
      const env2 = JSON.parse(r2.stdout.trim()) as {
        data: { inserted: number; skipped_existing: number };
      };
      expect(env2.data.inserted).toBe(0);
      expect(env2.data.skipped_existing).toBe(1);
    } finally {
      db.close();
    }
  });

  it("export manifest schema_version matches DB 1.4.0", async () => {
    const out = path.join(root, "bundle.tar.gz");
    const r = runCli(root, ["--json", "export", "--output", out]);
    expect(r.status).toBe(0);
    const env = JSON.parse(r.stdout.trim()) as {
      data: { schemaVersion: string; payloadVersion?: string };
    };
    expect(env.data.schemaVersion).toBe("1.4.0");

    const db = new BetterSqlite3(path.join(root, ".cognit", "cognit.db"), {
      readonly: true,
    });
    try {
      const v = db.prepare("SELECT version FROM schema_version WHERE id = 1").get() as {
        version: string;
      };
      expect(v.version).toBe("1.4.0");
    } finally {
      db.close();
    }
  });
});

/**
 * D-M6-00 KD-23: import --merge-strategy fork remaps events.correlation_id
 * via the raw_events: id map (not events:).
 */
describe("cognit import fork remaps raw correlation_id (D-M6-00)", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cognit-raw-fork-"));
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("fork remaps correlation_id to new raw_events id", () => {
    const source = path.join(tmp, "source");
    fssync.mkdirSync(source, { recursive: true });
    expect(runCli(source, ["init", "--project", "fork-src"]).status).toBe(0);

    const RAW_ID = "01HZZZZZZZZZZZZZZZZZZZZZZR";
    const EVENT_ID = "01HZZZZZZZZZZZZZZZZZZZZZZE";
    const ACTOR_ID = "01HZZZZZZZZZZZZZZZZZZZZZZA";
    const now = new Date().toISOString();

    const srcDb = new BetterSqlite3(path.join(source, ".cognit", "cognit.db"));
    try {
      const project = srcDb.prepare("SELECT id FROM projects LIMIT 1").get() as { id: string };
      const sessionId = "01HZZZZZZZZZZZZZZZZZZZZZZ2";
      srcDb
        .prepare(
          `INSERT INTO sessions (id, project_id, parent_session_id, goal, status, last_snapshot_event_id, created_at, closed_at)
           VALUES (?, ?, NULL, 'fork-raw-test', 'active', NULL, ?, NULL)`,
        )
        .run(sessionId, project.id, now);
      srcDb
        .prepare(
          `INSERT INTO actors (id, type, name, trust_score, first_seen_at, last_seen_at)
           VALUES (?, 'worker', 'fork-worker', 0.6, ?, ?)`,
        )
        .run(ACTOR_ID, now, now);
      srcDb
        .prepare(
          `INSERT INTO raw_events (
            id, project_id, session_id, type, version, actor_name, actor_type,
            envelope_json, source_tool, source_command, domain_event_count, source_file, created_at
          ) VALUES (?, ?, ?, 'raw_tool_signal', '1.3.0', 'fork-worker', 'worker', ?, 'search_replace', 'PostToolUse', 1, NULL, ?)`,
        )
        .run(
          RAW_ID,
          project.id,
          sessionId,
          JSON.stringify({
            id: RAW_ID,
            type: "raw_tool_signal",
            version: "1.3.0",
            session_id: sessionId,
            actor_name: "fork-worker",
            actor_type: "worker",
            payload: { phase: "post", host: "grok", tool: "search_replace", text: "x" },
          }),
          now,
        );
      srcDb
        .prepare(
          `INSERT INTO events (
            id, project_id, session_id, actor_id, type, version, payload_json,
            correlation_id, created_at
          ) VALUES (?, ?, ?, ?, 'action_recorded', '1.3.0', ?, ?, ?)`,
        )
        .run(
          EVENT_ID,
          project.id,
          sessionId,
          ACTOR_ID,
          JSON.stringify({ text: "Changed x.ts", action_kind: "other" }),
          RAW_ID,
          now,
        );
    } finally {
      srcDb.close();
    }

    const bundle = path.join(tmp, "bundle.tar.gz");
    expect(runCli(source, ["export", "--output", bundle]).status).toBe(0);

    const dest = path.join(tmp, "dest");
    fssync.mkdirSync(dest, { recursive: true });
    expect(runCli(dest, ["init", "--project", "fork-dst"]).status).toBe(0);
    const imp = runCli(dest, ["import", "--input", bundle, "--merge-strategy", "fork"]);
    expect(imp.status).toBe(0);
    expect(imp.stdout).toMatch(/forked:\s+[1-9]/);

    const destDb = new BetterSqlite3(path.join(dest, ".cognit", "cognit.db"), {
      readonly: true,
    });
    try {
      // Source raw id must not remain as a primary key after fork remap.
      const oldRaw = destDb.prepare("SELECT id FROM raw_events WHERE id = ?").get(RAW_ID);
      expect(oldRaw).toBeUndefined();

      const rawRows = destDb
        .prepare("SELECT id FROM raw_events")
        .all() as Array<{ id: string }>;
      expect(rawRows.length).toBeGreaterThanOrEqual(1);

      // Domain action_recorded with correlation must point at a live raw_events id.
      const domain = destDb
        .prepare(
          `SELECT id, correlation_id FROM events
           WHERE type = 'action_recorded' AND correlation_id IS NOT NULL
           LIMIT 1`,
        )
        .get() as { id: string; correlation_id: string } | undefined;
      expect(domain).toBeDefined();
      expect(domain!.correlation_id).not.toBe(RAW_ID);
      const linked = destDb
        .prepare("SELECT id FROM raw_events WHERE id = ?")
        .get(domain!.correlation_id);
      expect(linked).toBeDefined();
      expect((linked as { id: string }).id).toBe(domain!.correlation_id);
    } finally {
      destDb.close();
    }
  });
});
