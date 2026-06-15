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
  tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "cognit-json-"));
});

afterEach(async () => {
  await fs.promises.rm(tmp, { recursive: true, force: true });
});

describe("cognit --json envelope", () => {
  it("cognit --json session list emits { version: 1, kind, data: [...] } parseable by JSON.parse", () => {
    expect(runCli(tmp, ["init", "--project", "demo"]).status).toBe(0);
    expect(runCli(tmp, ["session", "create", "x"]).status).toBe(0);

    const r = runCli(tmp, ["--json", "session", "list"]);
    expect(r.status).toBe(0);
    const env = JSON.parse(r.stdout) as {
      version: number;
      kind: string;
      data: ReadonlyArray<{ id: string; status: string; goal: string }>;
    };
    expect(env.version).toBe(1);
    expect(env.kind).toBe("session.list");
    expect(Array.isArray(env.data)).toBe(true);
    expect(env.data).toHaveLength(1);
    expect(env.data[0]?.status).toBe("active");
    expect(env.data[0]?.goal).toBe("x");
  });

  it("cognit --json session show emits { version: 1, kind: 'session.show', data: {...} }", () => {
    expect(runCli(tmp, ["init", "--project", "demo"]).status).toBe(0);
    const create = runCli(tmp, ["session", "create", "show me"]);
    expect(create.status).toBe(0);
    const idMatch = create.stdout.match(/session:\s+(01[A-Z0-9]+)/i);
    expect(idMatch).not.toBeNull();
    const sessionId = idMatch![1]!;

    const r = runCli(tmp, ["--json", "session", "show", sessionId]);
    expect(r.status).toBe(0);
    const env = JSON.parse(r.stdout) as {
      version: number;
      kind: string;
      data: { session: { id: string }; state: { session_id: string } };
    };
    expect(env.version).toBe(1);
    expect(env.kind).toBe("session.show");
    expect(env.data.session.id).toBe(sessionId);
    expect(env.data.state.session_id).toBe(sessionId);
  });

  it("text mode (default) does NOT emit a JSON envelope", () => {
    expect(runCli(tmp, ["init", "--project", "demo"]).status).toBe(0);
    expect(runCli(tmp, ["session", "create", "plain"]).status).toBe(0);
    const r = runCli(tmp, ["session", "list"]);
    expect(r.status).toBe(0);
    // The first character should not be `{` (no JSON envelope).
    expect(r.stdout.trimStart().startsWith("{")).toBe(false);
  });

  it("cognit schema-dump prints a TypeScript type definition including JsonEnvelopeV1", () => {
    const r = runCli(tmp, ["schema-dump"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("JsonEnvelopeV1");
    expect(r.stdout).toContain("version: 1");
    expect(r.stdout).toContain("kind: string");
    expect(r.stdout).toContain("data: T");
  });
});
