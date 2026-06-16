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

interface Envelope {
  version: number;
  kind: string;
  data: unknown;
}

let tmp: string;

beforeEach(async () => {
  tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "cognit-json-"));
});

afterEach(async () => {
  await fs.promises.rm(tmp, { recursive: true, force: true });
});

/** Init project + create a session + return the session id. */
function bootstrapSession(goal: string): string {
  expect(runCli(tmp, ["init", "--project", "demo"]).status).toBe(0);
  const create = runCli(tmp, ["session", "create", goal]);
  expect(create.status).toBe(0);
  const idMatch = create.stdout.match(/session:\s+(01[A-Z0-9]+)/i);
  expect(idMatch).not.toBeNull();
  return idMatch![1]!;
}

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

  // ---------- 12 new envelope-wired commands ----------

  it("cognit --json observation.add emits { version: 1, kind: 'observation.add', data: { event } }", () => {
    const sessionId = bootstrapSession("json observe");
    const r = runCli(tmp, ["--json", "observe", "hello", "--session", sessionId]);
    expect(r.status).toBe(0);
    const env = JSON.parse(r.stdout) as Envelope;
    expect(env.version).toBe(1);
    expect(env.kind).toBe("observation.add");
    const data = env.data as { event: { type: string; session_id: string } };
    expect(data.event.type).toBe("observation_recorded");
    expect(data.event.session_id).toBe(sessionId);
  });

  it("cognit --json finding.add emits { version: 1, kind: 'finding.add', data: { event } }", () => {
    const sessionId = bootstrapSession("json finding");
    const r = runCli(tmp, ["--json", "finding", "synth", "--session", sessionId]);
    expect(r.status).toBe(0);
    const env = JSON.parse(r.stdout) as Envelope;
    expect(env.version).toBe(1);
    expect(env.kind).toBe("finding.add");
    const data = env.data as { event: { type: string; session_id: string } };
    expect(data.event.type).toBe("finding_created");
    expect(data.event.session_id).toBe(sessionId);
  });

  it("cognit --json hypothesis.propose emits { version: 1, kind: 'hypothesis.propose', data: { event } }", () => {
    const sessionId = bootstrapSession("json hyp propose");
    const r = runCli(tmp, [
      "--json",
      "hypothesis",
      "propose",
      "H1",
      "--text",
      "we believe X",
      "--session",
      sessionId,
    ]);
    expect(r.status).toBe(0);
    const env = JSON.parse(r.stdout) as Envelope;
    expect(env.version).toBe(1);
    expect(env.kind).toBe("hypothesis.propose");
    const data = env.data as { event: { type: string } };
    expect(data.event.type).toBe("hypothesis_created");
  });

  // The hypothesis lifecycle ops (weaken / reject / promote) require a
  // pre-existing `hypotheses` row to satisfy the `linked_hypothesis_id`
  // FK; the proposal path does not yet populate that table. The
  // envelope wiring is in place for all four subcommands — the
  // corresponding `text`-mode smoke tests live in
  // `hypothesis.test.ts` (propose only, matching the existing test
  // surface).

  it("cognit --json theory.add emits { version: 1, kind: 'theory.add', data: { event } }", () => {
    const sessionId = bootstrapSession("json theory add");
    const r = runCli(tmp, [
      "--json",
      "theory",
      "add",
      "T1",
      "--text",
      "the sky is blue",
      "--session",
      sessionId,
    ]);
    expect(r.status).toBe(0);
    const env = JSON.parse(r.stdout) as Envelope;
    expect(env.version).toBe(1);
    expect(env.kind).toBe("theory.add");
    const data = env.data as { event: { type: string } };
    expect(data.event.type).toBe("theory_created");
  });

  it("cognit --json experiment.add emits { version: 1, kind: 'experiment.add', data: { event } }", () => {
    const sessionId = bootstrapSession("json exp add");
    const r = runCli(tmp, [
      "--json",
      "experiment",
      "add",
      "--tests-hypothesis",
      "01HYPE00000000000000000000",
      "--design",
      "run unit tests",
      "--session",
      sessionId,
    ]);
    expect(r.status).toBe(0);
    const env = JSON.parse(r.stdout) as Envelope;
    expect(env.version).toBe(1);
    expect(env.kind).toBe("experiment.add");
    const data = env.data as { event: { type: string } };
    expect(data.event.type).toBe("experiment_created");
  });

  it("cognit --json decision.propose emits { version: 1, kind: 'decision.propose', data: { event } }", () => {
    const sessionId = bootstrapSession("json dec propose");
    const r = runCli(tmp, [
      "--json",
      "decision",
      "propose",
      "use Redis",
      "--based-on",
      "01CONC00000000000000000000",
      "--session",
      sessionId,
    ]);
    expect(r.status).toBe(0);
    const env = JSON.parse(r.stdout) as Envelope;
    expect(env.version).toBe(1);
    expect(env.kind).toBe("decision.propose");
    const data = env.data as { event: { type: string } };
    expect(data.event.type).toBe("decision_proposed");
  });

  it("cognit --json conclusion.propose emits { version: 1, kind: 'conclusion.propose', data: { event } }", () => {
    const sessionId = bootstrapSession("json concl propose");
    const r = runCli(tmp, [
      "--json",
      "conclusion",
      "propose",
      "the bug is a race",
      "--session",
      sessionId,
    ]);
    expect(r.status).toBe(0);
    const env = JSON.parse(r.stdout) as Envelope;
    expect(env.version).toBe(1);
    expect(env.kind).toBe("conclusion.propose");
    const data = env.data as { event: { type: string } };
    expect(data.event.type).toBe("conclusion_proposed");
  });

  it("cognit --json verification.start emits { version: 1, kind: 'verification.start', data: { started, terminal, ... } }", () => {
    const sessionId = bootstrapSession("json verify start");
    // `--` separates commander options from the spawned command. Use
    // a deterministic `node -e` so the test never depends on a
    // real `pnpm` install.
    const r = runCli(tmp, [
      "--json",
      "verify",
      "--type",
      "test",
      "--session",
      sessionId,
      "--",
      "node",
      "-e",
      "process.stdout.write('hi')",
    ]);
    expect(r.status).toBe(0);
    const env = JSON.parse(r.stdout) as Envelope;
    expect(env.version).toBe(1);
    expect(env.kind).toBe("verification.start");
    const data = env.data as {
      started: { type: string };
      terminal: { type: string };
      terminal_type: string;
    };
    expect(data.started.type).toBe("verification_started");
    expect(data.terminal.type).toBe("verification_passed");
    expect(data.terminal_type).toBe("verification_passed");
  });

  it("cognit --json edge.add emits { version: 1, kind: 'edge.add', data: { event, edge } }", () => {
    const sessionId = bootstrapSession("json edge add");
    const r = runCli(tmp, [
      "--json",
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
    expect(r.status).toBe(0);
    const env = JSON.parse(r.stdout) as Envelope;
    expect(env.version).toBe(1);
    expect(env.kind).toBe("edge.add");
    const data = env.data as {
      event: { type: string };
      edge: { from: string; to: string; kind: string };
    };
    expect(data.event.type).toBe("edge_created");
    expect(data.edge.from).toBe("conclusion:01CONC00000000000000000000");
    expect(data.edge.to).toBe("decision:01DECI00000000000000000000");
    expect(data.edge.kind).toBe("supports");
  });

  it("cognit --json artifact.add emits { version: 1, kind: 'artifact.add', data: { event } }", () => {
    const sessionId = bootstrapSession("json artifact add");
    const r = runCli(tmp, [
      "--json",
      "artifact",
      "add",
      "--id",
      "01ARTI00000000000000000000",
      "--role",
      "evidence",
      "--session",
      sessionId,
    ]);
    expect(r.status).toBe(0);
    const env = JSON.parse(r.stdout) as Envelope;
    expect(env.version).toBe(1);
    expect(env.kind).toBe("artifact.add");
    const data = env.data as { event: { type: string } };
    expect(data.event.type).toBe("artifact_attached");
  });

  it("cognit --json append emits { version: 1, kind: 'append', data: { event, snapshotTaken } }", () => {
    const sessionId = bootstrapSession("json append");
    const r = runCli(tmp, [
      "--json",
      "append",
      "--type",
      "observation_recorded",
      "--payload",
      '{"text":"x"}',
      "--session",
      sessionId,
    ]);
    expect(r.status).toBe(0);
    const env = JSON.parse(r.stdout) as Envelope;
    expect(env.version).toBe(1);
    expect(env.kind).toBe("append");
    const data = env.data as { event: { type: string }; snapshotTaken: boolean };
    expect(data.event.type).toBe("observation_recorded");
    expect(typeof data.snapshotTaken).toBe("boolean");
  });

  it("cognit --json inbox --process emits { version: 1, kind: 'inbox', data: { processed, errored } }", () => {
    bootstrapSession("json inbox");
    const r = runCli(tmp, ["--json", "inbox", "--process"]);
    expect(r.status).toBe(0);
    const env = JSON.parse(r.stdout) as Envelope;
    expect(env.version).toBe(1);
    expect(env.kind).toBe("inbox");
    const data = env.data as { processed: number; errored: number };
    expect(data.processed).toBe(0);
    expect(data.errored).toBe(0);
  });

  it("cognit --json snapshot emits { version: 1, kind: 'snapshot.create', data: { snapshot, taken } }", () => {
    const sessionId = bootstrapSession("json snapshot");
    const r = runCli(tmp, ["--json", "snapshot", "--session", sessionId]);
    expect(r.status).toBe(0);
    const env = JSON.parse(r.stdout) as Envelope;
    expect(env.version).toBe(1);
    expect(env.kind).toBe("snapshot.create");
    const data = env.data as { snapshot: { id: string; session_id: string }; taken: boolean };
    expect(data.snapshot.session_id).toBe(sessionId);
    expect(typeof data.taken).toBe("boolean");
  });
});
