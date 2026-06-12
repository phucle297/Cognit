import path from "node:path";
import os from "node:os";
import fs from "node:fs";

/**
 * Resolve the local Cognit project root (the directory that contains
 * `.cognit/`). Walks up from `start` looking for `.cognit/cognit.yaml`.
 * Returns `null` when not found.
 */
export function findProjectRoot(start: string = process.cwd()): string | null {
  let current = path.resolve(start);
  const stop = path.parse(current).root;

  while (true) {
    const candidate = path.join(current, ".cognit", "cognit.yaml");
    if (fs.existsSync(candidate)) {
      return current;
    }
    if (current === stop) {
      return null;
    }
    current = path.dirname(current);
  }
}

/**
 * Resolve the `.cognit` directory for a given project root, or `null` if
 * the project has not been initialised.
 */
export function cognitDir(projectRoot: string): string {
  return path.join(projectRoot, ".cognit");
}

/**
 * Layout of the `.cognit/` directory. Created by `cognit init` and
 * extended by the database / inbox / snapshot subsystems in later
 * phases. See `plan.xml <local_files>`.
 */
export const COGNIT_SUBDIRS = [
  "inbox",
  "inbox/_error",
  "artifacts",
  "artifacts/curated",
  "snapshots",
  "archive",
] as const;

export const COGNIT_FILES = ["cognit.yaml", ".gitignore"] as const;

export interface ProjectPaths {
  root: string;
  dir: string;
  config: string;
  db: string;
  gitignore: string;
  inbox: string;
  inboxError: string;
  artifacts: string;
  artifactsCurated: string;
  snapshots: string;
  archive: string;
}

export function projectPaths(projectRoot: string): ProjectPaths {
  const dir = cognitDir(projectRoot);
  return {
    root: projectRoot,
    dir,
    config: path.join(dir, "cognit.yaml"),
    db: path.join(dir, "cognit.db"),
    gitignore: path.join(dir, ".gitignore"),
    inbox: path.join(dir, "inbox"),
    inboxError: path.join(dir, "inbox", "_error"),
    artifacts: path.join(dir, "artifacts"),
    artifactsCurated: path.join(dir, "artifacts", "curated"),
    snapshots: path.join(dir, "snapshots"),
    archive: path.join(dir, "archive"),
  };
}

export function isCognitProject(projectRoot: string): boolean {
  return fs.existsSync(path.join(cognitDir(projectRoot), "cognit.yaml"));
}

export function expandHome(p: string): string {
  if (p === "~") {
    return os.homedir();
  }
  if (p.startsWith("~/")) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}
