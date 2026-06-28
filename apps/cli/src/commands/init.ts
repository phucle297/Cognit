import fs from "node:fs/promises";
import path from "node:path";
import { Effect } from "effect";
import { Command } from "commander";
import { defaultConfig } from "@cognit/core/config";
import { ProjectService } from "@cognit/db";
import { COGNIT_SUBDIRS, projectPaths, isCognitProject } from "../paths.js";
import { writeConfig, writeCognitGitignore } from "../yaml-io.js";
import { withAppLayer } from "../layer-build.js";
import { detectAndInstallHooks, type HookInstallResult } from "../hook-installer.js";

interface InitOptions {
  project?: string;
  force?: boolean;
  root?: string;
}

/**
 * `cognit init [--project name] [--force] [--root <path>]`
 *
 * Initialise a local Cognit project. Root resolution order:
 *   1. `--root` flag
 *   2. `$COGNIT_ROOT` env var (used by the docker entrypoint so the
 *      `cli` service in `docker-compose.yml` can initialise the
 *      persistent volume at `/data` instead of the image's `/app`)
 *   3. `process.cwd()`
 *
 * Creates the `.cognit/` directory tree, writes a default
 * `cognit.yaml`, and adds a `.gitignore` snippet that keeps the
 * database and runtime state out of version control while committing
 * the config.
 */
export function registerInit(program: Command): void {
  program
    .command("init")
    .description(
      "initialise a local Cognit project in the current directory (or $COGNIT_ROOT / --root)",
    )
    .option("-p, --project <name>", "project name (default: directory name)")
    .option("-f, --force", "re-initialise an existing project (overwrite cognit.yaml)")
    .option("--root <path>", "project root (default: $COGNIT_ROOT or current directory)")
    .action(async (opts: InitOptions, command) => {
      // Accept `--root` from the program level (so `cognit --root /data init`
      // works, as the docker entrypoint invokes) or from this subcommand.
      const globals = command.optsWithGlobals() as { root?: string };
      const projectRoot = opts.root ?? globals.root ?? process.env.COGNIT_ROOT ?? process.cwd();
      const paths = projectPaths(projectRoot);

      if (isCognitProject(projectRoot) && !opts.force) {
        // Idempotent: the docker `init` service runs `cognit init`
        // on every `docker compose up`; treat an already-initialised
        // project as success so the bootstrap never wedges `up` on
        // existing volumes. The user can still pass `--force` to
        // overwrite the config.
        process.stdout.write(`cognit: ${paths.config} already exists; nothing to do.\n`);
        // Phase A.2: still re-run hook detection so a user who
        // installs a new AI tool after the first `cognit init` gets
        // hooks wired on the next run. Hook detection is itself
        // idempotent — already-wired tools are skipped.
        const hookResults = detectAndInstallHooks();
        printHookSummary(hookResults);
        return;
      }

      const projectName =
        opts.project && opts.project.length > 0 ? opts.project : path.basename(projectRoot);

      await fs.mkdir(paths.dir, { recursive: true });
      for (const sub of COGNIT_SUBDIRS) {
        await fs.mkdir(path.join(paths.dir, sub), { recursive: true });
      }

      const config = defaultConfig(projectName);
      await writeConfig(paths.config, config);
      await writeCognitGitignore(paths.gitignore);

      // Bootstrap the SQLite DB and insert the project row. The
      // server (and every CLI subcommand that touches the DB) reads
      // `projects` to resolve the current project; without this row
      // the server boots into a "no project found" crash loop.
      // `ensure` is idempotent — re-running init against an existing
      // row is a no-op — so the docker `init` service can run on
      // every `up` without harm.
      await Effect.runPromise(
        withAppLayer(
          projectRoot,
          Effect.gen(function* () {
            const projectService = yield* ProjectService;
            yield* projectService.ensure({ name: projectName });
          }),
        ),
      );

      process.stdout.write(`Initialised Cognit project: ${projectName}\n`);
      process.stdout.write(`  ${paths.config}\n`);
      for (const sub of COGNIT_SUBDIRS) {
        process.stdout.write(`  ${path.join(paths.dir, sub)}/\n`);
      }

      // Phase A.2: auto-detect installed AI tools and wire Cognit
      // hooks into each. Idempotent — re-running `cognit init` against
      // an already-wired tool is a no-op. Per-tool failures do NOT
      // fail the whole init; the operator gets a summary so they can
      // fix one tool at a time.
      const hookResults: HookInstallResult[] = detectAndInstallHooks();
      printHookSummary(hookResults);
    });
}

function padRight(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function printHookSummary(hookResults: HookInstallResult[]): void {
  if (hookResults.length === 0) return;
  const wired = hookResults.filter((r) => r.status === "installed" || r.status === "already-wired");
  process.stdout.write(`\nHooks:\n`);
  for (const r of hookResults) {
    const verb =
      r.status === "installed"
        ? "wired"
        : r.status === "already-wired"
          ? "already wired"
          : r.status === "tool-not-detected"
            ? "not installed"
            : r.status === "failed"
              ? "FAILED"
              : "skipped";
    const detail = r.detail ? `  (${r.detail})` : "";
    process.stdout.write(`  ${padRight(r.tool, 14)} ${verb}${detail}\n`);
  }
  if (wired.length === 0) {
    process.stdout.write(
      `\nNo AI tools detected. Run \`cognit init\` again after installing one, or wire hooks manually from docs/hooks/README.md.\n`,
    );
  }
}
