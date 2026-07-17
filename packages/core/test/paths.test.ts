import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  findProjectRoot,
  cognitDir,
  projectPaths,
  isCognitProject,
  expandHome,
  COGNIT_SUBDIRS,
  COGNIT_FILES,
  type ProjectPaths,
} from "../src/paths.js";

let tmp: string;

beforeEach(async () => {
  tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "cognit-core-paths-"));
});

afterEach(async () => {
  await fs.promises.rm(tmp, { recursive: true, force: true });
});

describe("findProjectRoot", () => {
  it("returns the start directory when it contains .cognit/cognit.yaml (hit)", async () => {
    const cognit = path.join(tmp, ".cognit");
    await fs.promises.mkdir(cognit, { recursive: true });
    await fs.promises.writeFile(path.join(cognit, "cognit.yaml"), "project: { name: x }\n");
    expect(findProjectRoot(tmp)).toBe(tmp);
  });

  it("walks up from nested directories until it finds the marker (hit, nested)", async () => {
    const cognit = path.join(tmp, ".cognit");
    await fs.promises.mkdir(cognit, { recursive: true });
    await fs.promises.writeFile(path.join(cognit, "cognit.yaml"), "project: { name: x }\n");
    const nested = path.join(tmp, "a", "b", "c");
    await fs.promises.mkdir(nested, { recursive: true });
    expect(findProjectRoot(nested)).toBe(tmp);
  });

  it("returns null when no ancestor contains the marker (miss)", () => {
    expect(findProjectRoot(tmp)).toBeNull();
  });

  it("stops at filesystem root without throwing when no project is found (stop at root)", () => {
    // The OS root has no .cognit/cognit.yaml. The function must stop
    // (returning null) at the parsed root rather than walking forever.
    const root = path.parse(os.tmpdir()).root;
    expect(findProjectRoot(root)).toBeNull();
  });
});

describe("cognitDir", () => {
  it("returns <projectRoot>/.cognit", () => {
    expect(cognitDir(tmp)).toBe(path.join(tmp, ".cognit"));
  });
});

describe("projectPaths", () => {
  it("returns a ProjectPaths with every documented key", () => {
    const p: ProjectPaths = projectPaths(tmp);
    const expectedKeys = [
      "root",
      "dir",
      "config",
      "db",
      "gitignore",
      "inbox",
      "inboxError",
      "processed",
      "artifacts",
      "artifactsCurated",
      "snapshots",
      "archive",
      "currentSession",
      "currentSessionTmp",
    ];
    for (const k of expectedKeys) {
      expect(p).toHaveProperty(k);
    }
    expect(p.root).toBe(tmp);
    expect(p.dir).toBe(path.join(tmp, ".cognit"));
    expect(p.config).toBe(path.join(tmp, ".cognit", "cognit.yaml"));
    expect(p.db).toBe(path.join(tmp, ".cognit", "cognit.db"));
    expect(p.gitignore).toBe(path.join(tmp, ".cognit", ".gitignore"));
    expect(p.inbox).toBe(path.join(tmp, ".cognit", "inbox"));
    expect(p.inboxError).toBe(path.join(tmp, ".cognit", "inbox", "_error"));
    expect(p.processed).toBe(path.join(tmp, ".cognit", "processed"));
    expect(p.artifacts).toBe(path.join(tmp, ".cognit", "artifacts"));
    expect(p.artifactsCurated).toBe(path.join(tmp, ".cognit", "artifacts", "curated"));
    expect(p.snapshots).toBe(path.join(tmp, ".cognit", "snapshots"));
    expect(p.archive).toBe(path.join(tmp, ".cognit", "archive"));
    expect(p.currentSession).toBe(path.join(tmp, ".cognit", "current-session"));
    expect(p.currentSessionTmp).toBe(path.join(tmp, ".cognit", "current-session.tmp"));
  });
});

describe("isCognitProject", () => {
  it("returns false when .cognit/cognit.yaml is absent", () => {
    expect(isCognitProject(tmp)).toBe(false);
  });

  it("returns true once cognit.yaml is present", async () => {
    const dir = path.join(tmp, ".cognit");
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(path.join(dir, "cognit.yaml"), "project: { name: x }\n");
    expect(isCognitProject(tmp)).toBe(true);
  });
});

describe("expandHome", () => {
  it("expands bare '~' to the user's home directory", () => {
    expect(expandHome("~")).toBe(os.homedir());
  });

  it("expands '~/x' to <homedir>/x", () => {
    expect(expandHome("~/foo/bar")).toBe(path.join(os.homedir(), "foo", "bar"));
  });

  it("leaves absolute paths unchanged", () => {
    const abs = path.resolve("/tmp/absolute/path");
    expect(expandHome(abs)).toBe(abs);
  });

  it("leaves relative paths without a leading '~' unchanged", () => {
    expect(expandHome("relative/path")).toBe("relative/path");
  });
});

describe("COGNIT_SUBDIRS / COGNIT_FILES constants", () => {
  it("COGNIT_SUBDIRS lists the documented layout", () => {
    expect([...COGNIT_SUBDIRS]).toEqual([
      "inbox",
      "inbox/_error",
      "artifacts",
      "artifacts/curated",
      "snapshots",
      "archive",
    ]);
  });

  it("COGNIT_FILES lists the documented files", () => {
    expect([...COGNIT_FILES]).toEqual(["cognit.yaml", ".gitignore"]);
  });
});
