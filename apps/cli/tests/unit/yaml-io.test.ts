import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultConfig } from "@cognit/core/config";
import { readConfig, writeConfig, writeCognitGitignore, COGNIT_GITIGNORE } from "../../src/yaml-io.js";

let tmp: string;

beforeEach(async () => {
  tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "cognit-yaml-"));
});

afterEach(async () => {
  await fs.promises.rm(tmp, { recursive: true, force: true });
});

describe("yaml-io", () => {
  it("writeConfig then readConfig round-trips", async () => {
    const cfgPath = path.join(tmp, "cognit.yaml");
    const cfg = defaultConfig("roundtrip");
    await writeConfig(cfgPath, cfg);
    const back = await readConfig(cfgPath);
    expect(back.project.name).toBe("roundtrip");
    expect(back.redaction.enabled).toBe(true);
    expect(back.inbox.atomic_write_required).toBe(true);
  });

  it("readConfig rejects invalid YAML", async () => {
    const cfgPath = path.join(tmp, "cognit.yaml");
    await fs.promises.writeFile(cfgPath, 'project: { name: "x" }\nredaction: { enabled: "yes" }\n');
    await expect(readConfig(cfgPath)).rejects.toThrow();
  });

  it("writeCognitGitignore creates the .gitignore snippet", async () => {
    const giPath = path.join(tmp, ".gitignore");
    await writeCognitGitignore(giPath);
    const text = await fs.promises.readFile(giPath, "utf8");
    expect(text).toBe(COGNIT_GITIGNORE);
    expect(text).toContain("cognit.db");
    expect(text).toContain("inbox/");
  });
});
