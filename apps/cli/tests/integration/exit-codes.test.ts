/**
 * D-M2-01 — exit code contract.
 *
 * 0 = success, 1 = runtime, 2 = usage / not a project / bad args.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { runCli } from "../helpers/run-cli";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmp: string;

beforeEach(async () => {
  tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "cognit-exit-codes-"));
});

afterEach(async () => {
  await fs.promises.rm(tmp, { recursive: true, force: true });
});

describe("exit code contract", () => {
  it("returns 0 on successful public verbs", () => {
    expect(runCli(tmp, ["init", "--project", "exit-demo"]).status).toBe(0);
    const obs = runCli(tmp, ["observation", "hello exit codes"]);
    expect(obs.status).toBe(0);
    const cont = runCli(tmp, ["continue"]);
    expect(cont.status).toBe(0);
  });

  it("returns 2 when outside a Cognit project", () => {
    const cont = runCli(tmp, ["continue"]);
    expect(cont.status).toBe(2);
    expect(cont.stderr).toMatch(/no \.cognit\/cognit\.yaml|init/i);

    const obs = runCli(tmp, ["observation", "nope"]);
    expect(obs.status).toBe(2);

    const search = runCli(tmp, ["search", "anything"]);
    expect(search.status).toBe(2);
  });

  it("returns 2 for bad usage / missing required args", () => {
    expect(runCli(tmp, ["init", "--project", "usage-demo"]).status).toBe(0);
    // observation requires text
    const missing = runCli(tmp, ["observe"]);
    expect(missing.status).toBe(2);

    // completion rejects unknown shell
    const badShell = runCli(tmp, ["completion", "tcsh"]);
    expect(badShell.status).toBe(2);
  });

  it("returns 1 on forced runtime / DB failure", () => {
    expect(runCli(tmp, ["init", "--project", "runtime-demo"]).status).toBe(0);
    const dbPath = path.join(tmp, ".cognit", "cognit.db");
    // Replace the SQLite file with a directory so open fails hard.
    fs.rmSync(dbPath, { force: true });
    fs.mkdirSync(dbPath, { recursive: true });

    const obs = runCli(tmp, ["observation", "should fail runtime"]);
    expect(obs.status).toBe(1);
    expect(obs.stderr.length).toBeGreaterThan(0);
  });
});
