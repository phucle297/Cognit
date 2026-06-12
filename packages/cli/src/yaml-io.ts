import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { Schema } from "effect";
import { CognitConfigSchema, type CognitConfig } from "@cognit/core/config";

/**
 * Read a `.cognit/cognit.yaml` from disk, parse it, and Effect-Schema-validate it.
 * Throws when the file is missing or invalid; the caller decides what
 * to do (typically: ask the user to run `cognit init`).
 */
export async function readConfig(configPath: string): Promise<CognitConfig> {
  const text = await fs.readFile(configPath, "utf8");
  const parsed = YAML.parse(text);
  return Schema.decodeUnknownSync(CognitConfigSchema)(parsed);
}

/**
 * Write a Cognit config to disk in a stable, human-readable form.
 * The output is sorted by top-level key for deterministic diffs.
 */
export async function writeConfig(configPath: string, config: CognitConfig): Promise<void> {
  // validate the round-trip; the caller already has a typed value, but
  // this guards against accidental shape drift.
  Schema.decodeUnknownSync(CognitConfigSchema)(config);
  const text = YAML.stringify(config, {
    indent: 2,
    sortMapEntries: true,
  });
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, text, "utf8");
}

/**
 * The `.gitignore` snippet that lives *inside* `.cognit/`. Mirrors
 * `plan.xml <local_files> <gitignore_template>` and the README's
 * Local Storage section. The `cognit.yaml` is committed; the rest
 * of the local state is gitignored.
 */
export const COGNIT_GITIGNORE = [
  "# Cognit local state. Commit cognit.yaml; ignore the rest.",
  "cognit.db",
  "cognit.db-journal",
  "cognit.db-wal",
  "cognit.db-shm",
  "inbox/",
  "snapshots/",
  "archive/",
  "",
].join("\n");

export async function writeCognitGitignore(gitignorePath: string): Promise<void> {
  await fs.mkdir(path.dirname(gitignorePath), { recursive: true });
  await fs.writeFile(gitignorePath, COGNIT_GITIGNORE, "utf8");
}
