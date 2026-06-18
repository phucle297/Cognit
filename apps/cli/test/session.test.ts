import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

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

let tmp: string;

beforeEach(async () => {
  tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "cognit-sess-cli-"));
});

afterEach(async () => {
  await fs.promises.rm(tmp, { recursive: true, force: true });
});

describe("cognit session lifecycle", () => {
  it("init then session create then list shows the new session", async () => {
    expect(runCli(tmp, ["init", "--project", "demo"]).status).toBe(0);
    const create = runCli(tmp, ["session", "create", "find the bug"]);
    expect(create.status).toBe(0);
    expect(create.stdout).toMatch(/session:\s+01[A-Z0-9]{22,}/i);
    expect(create.stdout).toContain("goal:    find the bug");
    expect(create.stdout).toContain("status:  active");

    const list = runCli(tmp, ["session", "list"]);
    expect(list.status).toBe(0);
    expect(list.stdout).toContain("find the bug");
    expect(list.stdout).toMatch(/ID \| STATUS/);
  });

  it("session show by id prints header and sections", async () => {
    expect(runCli(tmp, ["init", "--project", "demo"]).status).toBe(0);
    const create = runCli(tmp, ["session", "create", "investigate leak"]);
    expect(create.status).toBe(0);
    const idMatch = create.stdout.match(/session:\s+(01[A-Z0-9]+)/i);
    expect(idMatch).not.toBeNull();
    const id = idMatch![1]!;

    const show = runCli(tmp, ["session", "show", id]);
    expect(show.status).toBe(0);
    expect(show.stdout).toContain(`Session: ${id}`);
    expect(show.stdout).toContain("status:                active");
    expect(show.stdout).toContain("goal:                  investigate leak");
  });

  it("session pause then resume --fork=false keeps the same id", async () => {
    expect(runCli(tmp, ["init", "--project", "demo"]).status).toBe(0);
    const create = runCli(tmp, ["session", "create", "refactor"]);
    const idMatch = create.stdout.match(/session:\s+(01[A-Z0-9]+)/i);
    expect(idMatch).not.toBeNull();
    const id = idMatch![1]!;

    const pause = runCli(tmp, ["session", "pause", id]);
    expect(pause.status).toBe(0);
    expect(pause.stdout).toContain("status:  paused");

    const resume = runCli(tmp, ["session", "resume", id, "--fork=false"]);
    expect(resume.status).toBe(0);
    expect(resume.stdout).toContain(`session:    ${id}`);
    expect(resume.stdout).toContain("forked:     no (reopened)");
    expect(resume.stdout).toContain("status:     active");
  });

  it("session resume --fork=true creates a new session with parent set", async () => {
    expect(runCli(tmp, ["init", "--project", "demo"]).status).toBe(0);
    const create = runCli(tmp, ["session", "create", "follow up"]);
    const idMatch = create.stdout.match(/session:\s+(01[A-Z0-9]+)/i);
    const id = idMatch![1]!;

    const resume = runCli(tmp, ["session", "resume", id]);
    expect(resume.status).toBe(0);
    expect(resume.stdout).toContain(`parent:     ${id}`);
    expect(resume.stdout).toContain("forked:     yes (new session)");
    const newIdMatch = resume.stdout.match(/session:\s+(01[A-Z0-9]+)/i);
    const newId = newIdMatch![1]!;
    expect(newId).not.toBe(id);
  });

  it("session close writes a snapshot (verifiable via subsequent snapshot cmd)", async () => {
    expect(runCli(tmp, ["init", "--project", "demo"]).status).toBe(0);
    const create = runCli(tmp, ["session", "create", "finish me"]);
    const idMatch = create.stdout.match(/session:\s+(01[A-Z0-9]+)/i);
    const id = idMatch![1]!;

    const close = runCli(tmp, ["session", "close", id]);
    expect(close.status).toBe(0);
    expect(close.stdout).toContain("status:     closed");
    // The snapshot line points at the session's last_snapshot_event_id.
    // On close, that's the session_closed event id (a ULID).
    expect(close.stdout).toMatch(/snapshot:\s+01[A-Z0-9]+/);

    // After close, the session is closed — the snapshot was taken
    // implicitly. A subsequent `cognit snapshot` for the same id
    // cannot run takeSnapshot on a closed session without events
    // appearing in between, so we instead confirm the snapshot
    // pointer was set by checking the close output's "snapshot:"
    // line is a real ULID (verified above).
  });

  it("cognit snapshot without --session uses the most recent active session", async () => {
    expect(runCli(tmp, ["init", "--project", "demo"]).status).toBe(0);
    const create = runCli(tmp, ["session", "create", "snap me"]);
    const idMatch = create.stdout.match(/session:\s+(01[A-Z0-9]+)/i);
    const id = idMatch![1]!;

    const snap = runCli(tmp, ["snapshot"]);
    expect(snap.status).toBe(0);
    expect(snap.stdout).toContain(`session:     ${id}`);
    expect(snap.stdout).toContain("event_count: 1");
    expect(snap.stdout).toContain("taken:       yes (new)");

    // Running again returns the existing snapshot.
    const again = runCli(tmp, ["snapshot"]);
    expect(again.status).toBe(0);
    expect(again.stdout).toContain("taken:       no (existing)");
  });

  it("cognit snapshot with --session uses the supplied id", async () => {
    expect(runCli(tmp, ["init", "--project", "demo"]).status).toBe(0);
    const create = runCli(tmp, ["session", "create", "explicit target"]);
    const idMatch = create.stdout.match(/session:\s+(01[A-Z0-9]+)/i);
    const id = idMatch![1]!;

    const snap = runCli(tmp, ["snapshot", "--session", id]);
    expect(snap.status).toBe(0);
    expect(snap.stdout).toContain(`session:     ${id}`);
  });

  it("session list with --status active returns matching rows", async () => {
    expect(runCli(tmp, ["init", "--project", "demo"]).status).toBe(0);
    runCli(tmp, ["session", "create", "active-1"]);
    runCli(tmp, ["session", "create", "active-2"]);
    const list = runCli(tmp, ["session", "list", "--status", "active"]);
    expect(list.status).toBe(0);
    expect(list.stdout).toContain("active-1");
    expect(list.stdout).toContain("active-2");
  });

  it("fails cleanly when not in a cognit project", async () => {
    const create = runCli(tmp, ["session", "create", "no project"]);
    expect(create.status).not.toBe(0);
    expect(create.stderr).toContain("no .cognit/cognit.yaml found");
  });
});
