import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findProjectRoot, isCognitProject, projectPaths, COGNIT_SUBDIRS } from "../src/paths.js";

let tmp: string;

beforeEach(async () => {
  tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "cognit-paths-"));
});

afterEach(async () => {
  await fs.promises.rm(tmp, { recursive: true, force: true });
});

describe("paths", () => {
  it("isCognitProject returns false when no .cognit exists", () => {
    expect(isCognitProject(tmp)).toBe(false);
  });

  it("isCognitProject returns true once cognit.yaml is present", async () => {
    const dir = path.join(tmp, ".cognit");
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(path.join(dir, "cognit.yaml"), "project: { name: x }\n");
    expect(isCognitProject(tmp)).toBe(true);
  });

  it("findProjectRoot walks up from nested directories", async () => {
    const cognit = path.join(tmp, ".cognit");
    await fs.promises.mkdir(cognit, { recursive: true });
    await fs.promises.writeFile(path.join(cognit, "cognit.yaml"), "project: { name: x }\n");
    const nested = path.join(tmp, "a", "b", "c");
    await fs.promises.mkdir(nested, { recursive: true });
    expect(findProjectRoot(nested)).toBe(tmp);
  });

  it("findProjectRoot returns null outside a project", () => {
    expect(findProjectRoot(tmp)).toBeNull();
  });

  it("projectPaths returns the documented layout", () => {
    const p = projectPaths(tmp);
    expect(p.dir).toBe(path.join(tmp, ".cognit"));
    expect(p.config).toBe(path.join(tmp, ".cognit", "cognit.yaml"));
    expect(p.db).toBe(path.join(tmp, ".cognit", "cognit.db"));
    expect(p.inbox).toBe(path.join(tmp, ".cognit", "inbox"));
    expect(p.inboxError).toBe(path.join(tmp, ".cognit", "inbox", "_error"));
    expect(p.snapshots).toBe(path.join(tmp, ".cognit", "snapshots"));
    expect(p.archive).toBe(path.join(tmp, ".cognit", "archive"));
  });

  it("COGNIT_SUBDIRS matches plan.xml <local_files>", () => {
    expect([...COGNIT_SUBDIRS]).toEqual([
      "inbox",
      "inbox/_error",
      "artifacts",
      "artifacts/curated",
      "snapshots",
      "archive",
    ]);
  });
});
