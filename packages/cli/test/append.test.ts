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
  tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "cognit-append-cli-"));
});

afterEach(async () => {
  await fs.promises.rm(tmp, { recursive: true, force: true });
});

describe("cognit append", () => {
  it("appends an observation_recorded event to an active session", async () => {
    expect(runCli(tmp, ["init", "--project", "demo"]).status).toBe(0);
    const create = runCli(tmp, ["session", "create", "watch this"]);
    expect(create.status).toBe(0);
    const idMatch = create.stdout.match(/session:\s+(01[A-Z0-9]+)/i);
    expect(idMatch).not.toBeNull();
    const id = idMatch![1]!;

    const append = runCli(tmp, [
      "append",
      "--type",
      "observation_recorded",
      "--payload",
      '{"text":"hello world"}',
      "--session",
      id,
    ]);
    expect(append.status).toBe(0);
    expect(append.stdout).toMatch(/event:\s+01[A-Z0-9]+/i);
    expect(append.stdout).toContain("type:     observation_recorded");
    expect(append.stdout).toContain(`session:  ${id}`);
  });

  it("reads --payload from a .json file path", async () => {
    expect(runCli(tmp, ["init", "--project", "demo"]).status).toBe(0);
    const create = runCli(tmp, ["session", "create", "file payload"]);
    const idMatch = create.stdout.match(/session:\s+(01[A-Z0-9]+)/i);
    const id = idMatch![1]!;

    const payloadFile = path.join(tmp, "obs.json");
    fs.writeFileSync(payloadFile, JSON.stringify({ text: "from file" }));

    const append = runCli(tmp, [
      "append",
      "--type",
      "observation_recorded",
      "--payload",
      payloadFile,
      "--session",
      id,
    ]);
    expect(append.status).toBe(0);
    expect(append.stdout).toMatch(/event:\s+01[A-Z0-9]+/i);
  });

  it("fails cleanly when --payload file is missing", async () => {
    expect(runCli(tmp, ["init", "--project", "demo"]).status).toBe(0);
    const create = runCli(tmp, ["session", "create", "missing payload"]);
    const idMatch = create.stdout.match(/session:\s+(01[A-Z0-9]+)/i);
    const id = idMatch![1]!;

    const append = runCli(tmp, [
      "append",
      "--type",
      "observation_recorded",
      "--payload",
      "/nonexistent/path/to/payload.json",
      "--session",
      id,
    ]);
    expect(append.status).not.toBe(0);
    expect(append.stderr).toContain("file not found");
  });

  it("fails cleanly when --type is unknown", async () => {
    expect(runCli(tmp, ["init", "--project", "demo"]).status).toBe(0);
    const create = runCli(tmp, ["session", "create", "bad type"]);
    const idMatch = create.stdout.match(/session:\s+(01[A-Z0-9]+)/i);
    const id = idMatch![1]!;

    const append = runCli(tmp, [
      "append",
      "--type",
      "this_is_not_a_real_type",
      "--payload",
      '{"text":"x"}',
      "--session",
      id,
    ]);
    expect(append.status).not.toBe(0);
    expect(append.stderr).toContain("not a known event type");
  });

  it("fails cleanly when --session does not exist", async () => {
    expect(runCli(tmp, ["init", "--project", "demo"]).status).toBe(0);

    const append = runCli(tmp, [
      "append",
      "--type",
      "observation_recorded",
      "--payload",
      '{"text":"x"}',
      "--session",
      "01ZZZZZZZZZZZZZZZZZZZZZZZZ",
    ]);
    expect(append.status).not.toBe(0);
    expect(append.stderr).toContain("does not exist");
  });

  it("rejects --actor with an invalid type", async () => {
    expect(runCli(tmp, ["init", "--project", "demo"]).status).toBe(0);
    const create = runCli(tmp, ["session", "create", "bad actor"]);
    const idMatch = create.stdout.match(/session:\s+(01[A-Z0-9]+)/i);
    const id = idMatch![1]!;

    const append = runCli(tmp, [
      "append",
      "--type",
      "observation_recorded",
      "--payload",
      '{"text":"x"}',
      "--session",
      id,
      "--actor",
      "alice:robot",
    ]);
    expect(append.status).not.toBe(0);
    expect(append.stderr).toContain("human|worker|system");
  });

  it("fails when not in a cognit project", async () => {
    const append = runCli(tmp, [
      "append",
      "--type",
      "observation_recorded",
      "--payload",
      '{"text":"x"}',
      "--session",
      "01AAAAAAAAAAAAAAAAAAAAAAAA",
    ]);
    expect(append.status).not.toBe(0);
    expect(append.stderr).toContain("no .cognit/cognit.yaml found");
  });
});
