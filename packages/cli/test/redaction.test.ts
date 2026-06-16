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
  tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "cognit-redaction-cli-"));
});

afterEach(async () => {
  await fs.promises.rm(tmp, { recursive: true, force: true });
});

const init = (): void => {
  const r = runCli(tmp, ["init", "--project", "demo"]);
  expect(r.status).toBe(0);
};

/**
 * Write a custom redaction section to `.cognit/cognit.yaml`. We don't
 * rewrite the whole file — we splice the user patterns into the
 * default config that `cognit init` produced.
 */
const writeUserPatterns = (yaml: string): void => {
  const configPath = path.join(tmp, ".cognit", "cognit.yaml");
  const original = fs.readFileSync(configPath, "utf8");
  // Replace the default `redaction: { enabled: true, patterns: [] }`
  // block with the test's custom YAML.
  const redactionRegex = /redaction:\s*\n(?:[ \t]+.*\n)*/;
  const replaced = original.replace(redactionRegex, `redaction:\n${yaml}\n`);
  fs.writeFileSync(configPath, replaced);
};

describe("cognit redaction test", () => {
  it("dry-runs against all 4 built-in patterns", () => {
    init();
    const text =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc api_key=abcdefghijklmnop1234 password=sup3rs3cret -----BEGIN RSA PRIVATE KEY-----\nABC\n-----END RSA PRIVATE KEY-----";
    const out = runCli(tmp, ["redaction", "test", text]);
    expect(out.status).toBe(0);
    expect(out.stdout).toContain("jwt");
    expect(out.stdout).toContain("api_key_inline");
    expect(out.stdout).toContain("password_field");
    expect(out.stdout).toContain("pem_block");
    // Pull out just the `redacted: ...` line so the secret-material
    // check doesn't false-positive on the table column where we
    // intentionally print the *original* match for dry-run visibility.
    const redactedLine = out.stdout
      .split("\n")
      .find((l) => l.startsWith("redacted: "));
    expect(redactedLine).toBeDefined();
    expect(redactedLine).toContain("redacted: ");
    expect(redactedLine).not.toContain("abcdefghijklmnop1234");
    expect(redactedLine).not.toContain("sup3rs3cret");
    expect(redactedLine).not.toContain("ABC\n");
  });

  it("emits one row per match with span + match", () => {
    init();
    const out = runCli(tmp, ["redaction", "test", "token=abcdefghijklmnop1234"]);
    expect(out.status).toBe(0);
    const lines = out.stdout.split("\n");
    // Header line + at least one hit row.
    expect(lines[0]).toMatch(/^pattern\s+span\s+match/);
    const hitRow = lines.find((l) => l.includes("api_key_inline"));
    expect(hitRow).toBeDefined();
    expect(hitRow).toMatch(/api_key_inline\s+\[\d+, \d+\)\s+token=abcdefghijklmnop1234/);
  });

  it("applies a user pattern from cognit.yaml", () => {
    init();
    writeUserPatterns(
      [
        "  enabled: true",
        "  patterns:",
        "    - name: user_phone",
        '      regex: "\\\\b\\\\d{3}-\\\\d{3}-\\\\d{4}\\\\b"',
        '      replacement: "[REDACTED:user_phone]"',
      ].join("\n"),
    );
    const out = runCli(tmp, ["redaction", "test", "call 415-555-1234 please"]);
    expect(out.status).toBe(0);
    expect(out.stdout).toContain("user_phone");
    expect(out.stdout).toContain("415-555-1234");
    expect(out.stdout).toContain("redacted: call [REDACTED:user_phone] please");
  });

  it("reports a clean error for a malformed user regex", () => {
    init();
    writeUserPatterns(
      [
        "  enabled: true",
        "  patterns:",
        "    - name: bad",
        '      regex: "[unterminated"',
        '      replacement: "[REDACTED:bad]"',
      ].join("\n"),
    );
    const out = runCli(tmp, ["redaction", "test", "hello world"]);
    expect(out.status).not.toBe(0);
    expect(out.stderr).toContain("redaction.patterns.bad");
    // The underlying RegExp error message is appended for context.
    expect(out.stderr).toMatch(/SyntaxError|Invalid|regular expression/i);
    // No redaction line in the table — the command bailed early.
    expect(out.stdout).not.toContain("redacted: ");
  });

  it("emits a stable JSON envelope with --json", () => {
    init();
    const out = runCli(tmp, ["--json", "redaction", "test", "password=sup3rs3cret"]);
    expect(out.status).toBe(0);
    const env = JSON.parse(out.stdout) as {
      version: number;
      kind: string;
      data: {
        input: string;
        patterns: Array<{ name: string; regex: string; replacement: string }>;
        hits: Array<{ pattern: string; span: [number, number]; match: string }>;
        redacted: string;
      };
    };
    expect(env.version).toBe(1);
    expect(env.kind).toBe("redaction.test");
    expect(env.data.input).toBe("password=sup3rs3cret");
    expect(env.data.hits.length).toBeGreaterThan(0);
    const pwdHit = env.data.hits.find((h) => h.pattern === "password_field");
    expect(pwdHit).toBeDefined();
    expect(pwdHit!.match).toBe("password=sup3rs3cret");
    expect(env.data.redacted).toBe("password=[REDACTED:password]");
  });

  it("output is stable (deterministic order) for the same input", () => {
    init();
    const text = "api_key=abcdefghijklmnop1234 api_key=qrstuvwxyz1234567";
    const a = runCli(tmp, ["redaction", "test", text]);
    const b = runCli(tmp, ["redaction", "test", text]);
    expect(a.status).toBe(0);
    expect(b.status).toBe(0);
    expect(a.stdout).toBe(b.stdout);
  });

  it("writes nothing to the event store (no DB file mutation)", () => {
    init();
    // Re-init produces a fresh .cognit/ dir. We re-init so the layout
    // is exactly what `cognit redaction test` would see in a
    // post-init project.
    const dbPath = path.join(tmp, ".cognit", "cognit.db");
    const before = fs.existsSync(dbPath) ? fs.statSync(dbPath).size : 0;
    const out = runCli(tmp, ["redaction", "test", "password=sup3rs3cret"]);
    expect(out.status).toBe(0);
    const after = fs.existsSync(dbPath) ? fs.statSync(dbPath).size : 0;
    // The command is a pure dry-run — it must not touch the DB at all.
    expect(after).toBe(before);
    // And the redacted output is on stdout, not the DB.
    expect(out.stdout).toContain("redacted: ");
  });

  it("reports 'no matches' on text that fires no patterns", () => {
    init();
    const out = runCli(tmp, ["redaction", "test", "nothing sensitive here"]);
    expect(out.status).toBe(0);
    expect(out.stdout).toContain("no matches");
    // The redacted line still prints, with the input unchanged.
    expect(out.stdout).toContain("redacted: nothing sensitive here");
  });
});
