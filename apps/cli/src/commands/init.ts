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

/**
 * CLAUDE.md is the prompt that teaches Claude Code when to call
 * Cognit commands. It is written to the project root by `cognit init`
 * and refreshed on every re-init so version drift between CLI and
 * instructions is impossible. The file is plain markdown — Claude
 * Code's CLAUDE.md loader picks it up automatically with no plugin.
 *
 * M1.1: tightened to be command-oriented. Each verb has a single
 * trigger condition so Claude does not have to reason about when to
 * use Cognit — it just follows the table.
 */
const CLAUDE_MD = `# Cognit — memory for this project

You have a local memory store. Call these commands yourself when
the trigger matches. Do not ask the user to run them.

| When | Command |
|---|---|
| You noticed something the user will want to remember | \`cognit observation "<one line>"\` |
| You are about to make a non-trivial choice | \`cognit decision propose "<the choice>"\` |
| You have evidence (a test, lint, build, exec) | \`cognit verification run "<cmd>"\` |
| You are closing out a decision with that evidence | \`cognit conclusion propose "<claim>"\` |
| You start a new turn and want context | \`cognit continue\` |
| You need prior reasoning on a topic | \`cognit search "<query>"\` |

Rules:
- Do not run \`cognit session create\`. Cognit auto-creates a session
  on the first call. Just invoke the verb.
- Keep each \`observation\` to one line. The dashboard and
  \`cognit continue\` will summarise them.
- Always run \`verification\` for tests, lint, build, typecheck.
  Don't skip it.
- At the start of every turn (after compaction, after a long break),
  run \`cognit continue\` before answering.
- The user is not expected to run Cognit commands. If a memory op
  is needed, run it yourself via Bash.
`;

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
        // M1: refresh CLAUDE.md even on idempotent re-init so the
        // instructions stay in lockstep with the installed CLI.
        await fs.writeFile(path.join(projectRoot, "CLAUDE.md"), CLAUDE_MD, "utf8");
        process.stdout.write(`\nNext: open Claude Code. Reasoning will appear in \`cognit continue\`.\n`);
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

      // M1: write / refresh CLAUDE.md at the project root so Claude
      // Code (and any other AI tool that honours CLAUDE.md) learns
      // when to call the Cognit verbs. Idempotent — re-running init
      // overwrites with the current canonical text.
      await fs.writeFile(path.join(projectRoot, "CLAUDE.md"), CLAUDE_MD, "utf8");

      // Bootstrap the SQLite DB and insert the project row. The
      // server (and every CLI subcommand that touches the DB) reads
      // `projects` to resolve the current project; without this row
      // the server boots into a "no project found" crash loop.
      // `ensure` is idempotent — re-running init against an existing
      // row is a no-op — so the docker `init` service can run on
      // every `up` without harm.
      try {
        await Effect.runPromise(
          withAppLayer(
            projectRoot,
            Effect.gen(function* () {
              const projectService = yield* ProjectService;
              yield* projectService.ensure({ name: projectName });
            }),
          ),
        );
      } catch (e) {
        const msg = (e as Error).message ?? String(e);
        if (/SqliteError|no such column|malformed|database disk image/i.test(msg)) {
          process.stderr.write(
            `cognit: database schema is incompatible with this CLI.\n` +
              `  Cause: ${msg}\n` +
              `  Fix:   rm -rf .cognit/cognit.db .cognit/cognit.db-*  &&  cognit init\n`,
          );
        } else {
          process.stderr.write(`cognit: database bootstrap failed: ${msg}\n`);
        }
        process.exitCode = 1;
        return;
      }

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

      process.stdout.write(
        `\nNext: open Claude Code. Reasoning will appear in \`cognit continue\`.\n`,
      );
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
