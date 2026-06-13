import { Command } from "commander";
import { Effect } from "effect";
import { ProjectService, SessionService } from "@cognit/db";
import { findProjectRoot } from "../paths.js";
import { readConfig } from "../yaml-io.js";
import { withAppLayer } from "../layer-build.js";

interface SnapshotOptions {
  session?: string;
  actor?: string;
}

const VALID_ACTOR_TYPES = new Set(["human", "worker", "system"]);

const parseActor = (
  raw: string | undefined,
  defaultName: string,
  defaultType: "human" | "worker" | "system",
): { name: string; type: "human" | "worker" | "system" } => {
  if (!raw) return { name: defaultName, type: defaultType };
  const idx = raw.lastIndexOf(":");
  if (idx < 0) return { name: raw, type: defaultType };
  const name = raw.slice(0, idx);
  const type = raw.slice(idx + 1);
  if (!VALID_ACTOR_TYPES.has(type)) {
    process.stderr.write(`cognit: --actor type must be one of human|worker|system, got: ${type}\n`);
    process.exitCode = 2;
    return { name: defaultName, type: defaultType };
  }
  return { name: name || defaultName, type: type as "human" | "worker" | "system" };
};

const requireProjectRoot = (): string => {
  const root = findProjectRoot();
  if (!root) {
    process.stderr.write("cognit: no .cognit/cognit.yaml found. Run `cognit init` first.\n");
    process.exitCode = 2;
    throw new Error("not in a cognit project");
  }
  return root;
};

const loadProject = (root: string): Promise<{ id: string; name: string }> =>
  Effect.runPromise(withAppLayer(root, loadProjectEffect(root)));

const loadProjectEffect = (root: string) =>
  Effect.gen(function* () {
    const cfg = yield* Effect.tryPromise({
      try: () => readConfig(`${root}/.cognit/cognit.yaml`),
      catch: (e) => new Error(`readConfig: ${(e as Error).message}`),
    });
    const projectService = yield* ProjectService;
    const row = yield* projectService.ensure({ name: cfg.project.name });
    return { id: row.id, name: row.name };
  });

/**
 * Resolve the target session for a snapshot. If `--session` is given,
 * it is used as-is (id or goal, the SessionService handles it).
 * Otherwise we pick the most recently created active or paused
 * session for the project.
 */
const resolveTargetSession = async (
  root: string,
  projectId: string,
  ref: string | undefined,
): Promise<string> => {
  if (ref) return ref;
  const program = Effect.gen(function* () {
    const service = yield* SessionService;
    const active = yield* service.list({ projectId, status: "active" });
    if (active.length > 0) return active[0]?.id;
    const paused = yield* service.list({ projectId, status: "paused" });
    if (paused.length > 0) return paused[0]?.id;
    return undefined;
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const id = (await Effect.runPromise(withAppLayer(root, program) as any)) as string | undefined;
  if (!id) {
    process.stderr.write(
      "cognit: no --session given and no active/paused session in this project. Run `cognit session create` first.\n",
    );
    process.exitCode = 1;
    throw new Error("snapshot: no target session");
  }
  return id;
};

const runCommand = <A, E, R>(root: string, eff: Effect.Effect<A, E, R>): Promise<A> => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const provided = withAppLayer(root, eff) as any as Effect.Effect<A, E, never>;
  return Effect.runPromise(provided).catch((e: unknown) => {
    if (process.exitCode === undefined) process.exitCode = 1;
    process.stderr.write(`cognit: ${(e as Error).message ?? String(e)}\n`);
    throw e;
  });
};

export function registerSnapshot(program: Command): void {
  program
    .command("snapshot")
    .description("take (or return existing) snapshot for a session")
    .option("--session <id-or-goal>", "target session (defaults to the most recent active/paused)")
    .option("--actor <name:type>", 'actor override (default "cognit-cli:system")')
    .action(async (opts: SnapshotOptions) => {
      const root = requireProjectRoot();
      const project = await loadProject(root);
      const sessionRef = await resolveTargetSession(root, project.id, opts.session);
      // We don't actually pass the actor down to takeSnapshot yet
      // (snapshot trigger doesn't accept an actor in phase 2i); we
      // parse it for symmetry with the other commands and to fail
      // fast on bad input.
      parseActor(opts.actor, "cognit-cli", "system");

      await runCommand(
        root,
        Effect.gen(function* () {
          const service = yield* SessionService;
          const r = yield* service.takeSnapshot(sessionRef);
          process.stdout.write(`snapshot:    ${r.snapshot.id}\n`);
          process.stdout.write(`session:     ${r.snapshot.session_id}\n`);
          process.stdout.write(`event_count: ${r.snapshot.event_count}\n`);
          process.stdout.write(`taken:       ${r.taken ? "yes (new)" : "no (existing)"}\n`);
        }),
      );
    });
}
