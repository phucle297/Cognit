import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

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
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "cognit-inbox-cli-"));
});

afterEach(async () => {
  await fsp.rm(tmp, { recursive: true, force: true });
});

describe("cognit inbox --process", () => {
  it("moves a valid .json file from inbox to processed/", async () => {
    expect(runCli(tmp, ["init", "--project", "demo"]).status).toBe(0);
    const create = runCli(tmp, ["session", "create", "feed the inbox"]);
    expect(create.status).toBe(0);
    const idMatch = create.stdout.match(/session:\s+(01[A-Z0-9]+)/i);
    const sessionId = idMatch![1]!;

    // Write a well-formed inbox event. The InboxEnvelope schema
    // (Cognit-ttc) requires a `version` field, and the file name
    // must match `<session-ulid>-<event-ulid>.json`; otherwise the
    // file goes to _error/.
    const inboxDir = path.join(tmp, ".cognit", "inbox");
    const eventUlid = "01AAAAAAAAAAAAAAAAAAAAAAAA";
    const inboxFile = path.join(inboxDir, `${sessionId}-${eventUlid}.json`);
    const payload = {
      type: "observation_recorded",
      version: "1.1.0",
      session_id: sessionId,
      actor_name: "test",
      actor_type: "system",
      payload: { text: "from inbox" },
    };
    await fsp.writeFile(inboxFile, JSON.stringify(payload));

    const proc = runCli(tmp, ["inbox", "--process"]);
    expect(proc.status).toBe(0);
    expect(proc.stdout).toMatch(/processed:\s+1/);
    expect(proc.stdout).toMatch(/errored:\s+0/);

    // The inbox file is gone; processed/ holds the renamed event.
    expect(fs.existsSync(inboxFile)).toBe(false);
    const processedDir = path.join(tmp, ".cognit", "processed");
    const processedFiles = await fsp.readdir(processedDir);
    expect(processedFiles.some((n) => n.endsWith(".json"))).toBe(true);
  });

  it("moves a malformed .json file to _error/", async () => {
    expect(runCli(tmp, ["init", "--project", "demo"]).status).toBe(0);
    const create = runCli(tmp, ["session", "create", "bad json"]);
    const idMatch = create.stdout.match(/session:\s+(01[A-Z0-9]+)/i);
    const sessionId = idMatch![1]!;

    // File that fails inbox validation: missing required fields.
    const inboxDir = path.join(tmp, ".cognit", "inbox");
    const inboxFile = path.join(inboxDir, "bad-1.json");
    await fsp.writeFile(
      inboxFile,
      JSON.stringify({ type: "observation_recorded" /* missing fields */ }),
    );
    // Create a valid session row so a partial-validity file would resolve.
    void sessionId;

    const proc = runCli(tmp, ["inbox", "--process"]);
    expect(proc.status).toBe(0);
    expect(proc.stdout).toMatch(/errored:\s+1/);

    // The bad file is gone from the inbox; it's in _error/.
    expect(fs.existsSync(inboxFile)).toBe(false);
    const errorDir = path.join(tmp, ".cognit", "inbox", "_error");
    const errorFiles = await fsp.readdir(errorDir);
    expect(errorFiles.some((n) => n.endsWith(".json"))).toBe(true);
  });

  it("reports zero processed when the inbox is empty", async () => {
    expect(runCli(tmp, ["init", "--project", "demo"]).status).toBe(0);
    const proc = runCli(tmp, ["inbox", "--process"]);
    expect(proc.status).toBe(0);
    expect(proc.stdout).toMatch(/processed:\s+0/);
    expect(proc.stdout).toMatch(/errored:\s+0/);
  });

  it("fails when --process is called outside a cognit project", async () => {
    const proc = runCli(tmp, ["inbox", "--process"]);
    expect(proc.status).not.toBe(0);
    expect(proc.stderr).toContain("no .cognit/cognit.yaml found");
  });
});

describe("cognit inbox --watch", () => {
  it("starts the watcher without erroring and stays running", async () => {
    expect(runCli(tmp, ["init", "--project", "demo"]).status).toBe(0);

    const child = spawn(TSX, [CLI_ENTRY, "inbox", "--watch"], {
      cwd: tmp,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    // Give it a moment to wire up the watcher.
    await new Promise((r) => setTimeout(r, 500));

    // It should still be alive.
    expect(child.killed).toBe(false);
    if (child.exitCode !== null) {
      // It crashed. Surface stderr to help debugging.
      throw new Error(
        `cognit inbox --watch exited prematurely with code ${child.exitCode}; stderr=${stderr}`,
      );
    }

    child.kill("SIGKILL");
    // Reap so the test process doesn't leak.
    await new Promise<void>((resolve) => {
      child.on("exit", () => resolve());
      // Safety timeout in case exit never fires.
      setTimeout(resolve, 1000);
    });
  });

  it("fails cleanly when neither --watch nor --process is given", async () => {
    expect(runCli(tmp, ["init", "--project", "demo"]).status).toBe(0);
    const proc = runCli(tmp, ["inbox"]);
    expect(proc.status).not.toBe(0);
    expect(proc.stderr).toContain("requires --watch or --process");
  });
});
