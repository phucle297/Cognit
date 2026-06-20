/**
 * `cognit wrap -- <cmd> [args...]`
 *
 * Phase 9.2 (Cognit-b7q) — Producer side of the inbox contract.
 * Spawns `<cmd> [args...]`, captures stdout/stderr, and translates
 * the subprocess output into inbox JSON envelopes that the watcher
 * (`cognit inbox --watch`) picks up automatically.
 *
 * The literal `--` separator is mandatory (AC 9.2.1). This is the
 * syntax the spec calls out — `cognit wrap -- claude-code ...` —
 * and it makes the command boundary unambiguous when the wrapped
 * command starts with `--` itself.
 *
 * Per-line stderr observation policy: each non-empty stderr line
 * becomes a separate `observation_recorded` envelope. See
 * `packages/wrap/src/index.ts` for the rationale.
 *
 * Session resolution: `--session <id>` is required (or a sticky
 * session pointer must be set via `cognit session create`). Per
 * the audit §4, auto-creating a session per wrap invocation is
 * out of scope for this bead.
 */
import { Command } from "commander";
import { Effect } from "effect";
import { runWrap } from "@cognit/wrap";
import { findProjectRoot, projectPaths } from "../paths.js";
import { resolveSessionId, warnStalePointer } from "../session-resolver.js";
import { getOutputMode, emit } from "../output.js";

interface WrapOptions {
  session?: string;
  actor?: string;
  root?: string;
}

/**
 * Commander's argument parser does NOT carry a literal `--` token
 * into the `command` array — it consumes the `--` as a separator
 * and puts everything after it in the variadic positional. So we
 * reach into the underlying argv to verify the `--` was present.
 * If the user runs `cognit wrap ls -la` (without `--`) we reject.
 */
const requireDoubleDash = (): void => {
  if (!process.argv.includes("--")) {
    process.stderr.write(
      "cognit: wrap requires `--` separator before the command, e.g. `cognit wrap -- ls -la`\n",
    );
    process.exitCode = 2;
    throw new Error("wrap: missing `--` separator");
  }
};

const resolveProjectRoot = (raw: string | undefined): string => {
  if (raw) return raw;
  const root = findProjectRoot();
  if (!root) {
    process.stderr.write("cognit: no .cognit/cognit.yaml found. Run `cognit init` first.\n");
    process.exitCode = 2;
    throw new Error("not in a cognit project");
  }
  return root;
};

const requireSessionId = (root: string, raw: string | undefined): string => {
  const resolved = resolveSessionId(root, raw);
  if (!resolved) {
    process.stderr.write(
      "cognit: --session is required (or run `cognit session create` to set the sticky pointer)\n",
    );
    process.exitCode = 2;
    throw new Error("--session: missing");
  }
  if (resolved.source === "pointer") warnStalePointer(root, resolved.sessionId);
  return resolved.sessionId;
};

const parseActor = (raw: string | undefined): string => {
  if (!raw) return "cognit-wrap";
  // Accept either a bare name (`--actor foo`) or `name:type`
  // (`--actor foo:worker`). For wrap the actor_type is hardcoded to
  // `worker` downstream (the envelope schema constraint), so we
  // discard any `:<type>` suffix and keep just the name.
  const idx = raw.lastIndexOf(":");
  const name = idx < 0 ? raw : raw.slice(0, idx);
  if (name.length === 0) {
    // Bare colon (`--actor :worker`) or empty name. Fall back to
    // default rather than reject — the user clearly meant something,
    // and "cognit-wrap" is the safe default for untyped callers.
    process.stderr.write(
      `cognit: wrap: --actor "${raw}" has empty name; using default "cognit-wrap"\n`,
    );
    return "cognit-wrap";
  }
  return name;
};

const printSummary = (terminalType: string, count: number): void => {
  process.stdout.write(`terminal:  ${terminalType}\n`);
  process.stdout.write(`envelopes: ${count}\n`);
};

export function registerWrap(program: Command): void {
  program
    .command("wrap")
    .description(
      "spawn a worker command and translate its output into inbox envelopes (Phase 9.2)",
    )
    .option("--session <id>", "session id (ULID) for the produced envelopes (defaults to sticky current-session pointer)")
    .option("--actor <name>", 'actor name on the emitted envelopes (default "cognit-wrap")')
    .option("--root <path>", "project root (defaults to nearest .cognit/cognit.yaml)")
    .argument("[command...]", "the command to run after `--`")
    .action(async (command: string[] | undefined, opts: WrapOptions) => {
      requireDoubleDash();
      const argv = command ?? [];
      if (argv.length === 0) {
        process.stderr.write(
          "cognit: wrap requires a <command> after `--`, e.g. `cognit wrap -- bash -c 'echo hi'`\n",
        );
        process.exitCode = 2;
        throw new Error("wrap: missing command");
      }
      const root = resolveProjectRoot(opts.root);
      const sessionId = requireSessionId(root, opts.session);
      const actorName = parseActor(opts.actor);
      const paths = projectPaths(root);

      const ac = new AbortController();
      // Abort on SIGINT and SIGTERM so `kill <pid>` and Ctrl-C both
      // propagate to the wrapped subprocess. Without SIGTERM the
      // child only dies when the parent process is hard-killed,
      // which leaks orphaned workers on long runs.
      const onAbortSignal = (): void => {
        ac.abort();
      };
      process.on("SIGINT", onAbortSignal);
      process.on("SIGTERM", onAbortSignal);

      const program = runWrap({
        command: argv,
        cwd: root,
        env: process.env,
        signal: ac.signal,
        inboxDir: paths.inbox,
        artifactsDir: paths.artifacts,
        sessionId,
        actorName,
      });

      try {
        const out = await Effect.runPromise(program).catch((e: unknown) => {
          process.stderr.write(`cognit: wrap: ${(e as Error).message ?? String(e)}\n`);
          process.exitCode = 1;
          throw e;
        });
        if (getOutputMode() === "json") {
          emit("json", "wrap", {
            session_id: sessionId,
            terminal_type: out.terminalType,
            spawn_error_code: out.spawnErrorCode ?? null,
            written_files: out.writtenFiles,
            artifact_id: out.artifact?.id ?? null,
          });
          return;
        }
        printSummary(out.terminalType, out.writtenFiles.length);
        // Mirror the verification command's exit-code convention:
        // exit 0 on pass, 1 on fail, 2 on errored (spawn failed).
        if (out.terminalType === "verification_failed") process.exitCode = 1;
        else if (out.terminalType === "verification_errored") process.exitCode = 2;
      } finally {
        process.off("SIGINT", onAbortSignal);
        process.off("SIGTERM", onAbortSignal);
      }
    });
}
