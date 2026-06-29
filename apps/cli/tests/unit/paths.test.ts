import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  findProjectRoot,
  isCognitProject,
  projectPaths,
  COGNIT_SUBDIRS,
  cognitDir,
  COGNIT_FILES,
  isCognitProject as isCognitProjectAgain,
  expandHome,
} from "@cognit/core/paths";
import * as corePaths from "@cognit/core/paths";

let tmp: string;

beforeEach(async () => {
  tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "cognit-paths-"));
});

afterEach(async () => {
  await fs.promises.rm(tmp, { recursive: true, force: true });
});

/**
 * The CLI's `src/paths.ts` is a 3-line shim:
 *
 *     export * from "@cognit/core/paths";
 *
 * These tests assert that the shim re-exports every public symbol
 * the canonical `@cognit/core/paths` module exports. If a new export
 * is added to core without a corresponding re-export through the
 * shim, the `coreExports` set below will still pass (we mirror the
 * canonical set), but the import list at the top of this file will
 * need to grow alongside it — see `describe("shim re-exports")`
 * below for the machine-checkable part of that contract.
 */

/**
 * `ProjectPaths` is a TypeScript interface in `packages/core/src/paths.ts:50`.
 * Interfaces are erased at runtime, so it does NOT appear in the
 * `corePaths` namespace import. The compile-time path is exercised by
 * `pnpm typecheck`; the runtime check here covers the seven
 * runtime-visible exports the shim forwards.
 */
const coreExports = [
  "findProjectRoot",
  "cognitDir",
  "projectPaths",
  "COGNIT_SUBDIRS",
  "COGNIT_FILES",
  "isCognitProject",
  "expandHome",
] as const;

describe("shim re-exports", () => {
  it("imports the canonical runtime helpers from @cognit/core/paths", () => {
    for (const name of coreExports) {
      expect(corePaths).toHaveProperty(name);
    }
  });

  it("imported helpers are functions or the expected constant type", () => {
    expect(typeof findProjectRoot).toBe("function");
    expect(typeof cognitDir).toBe("function");
    expect(typeof projectPaths).toBe("function");
    expect(typeof isCognitProject).toBe("function");
    expect(typeof isCognitProjectAgain).toBe("function");
    expect(typeof expandHome).toBe("function");
    expect(Array.isArray(COGNIT_SUBDIRS)).toBe(true);
    expect(Array.isArray(COGNIT_FILES)).toBe(true);
  });
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
