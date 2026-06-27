import { Command } from "commander";
import { Effect, Exit, Cause } from "effect";
import {
  ProjectService,
  SessionService,
  type ActorType,
  type ProjectRow,
  type SessionRow,
  type SessionShowResult,
} from "@cognit/db";
import { VALID_ACTOR_TYPES } from "@cognit/core";
import { findProjectRoot, projectPaths } from "../paths.js";
import { readConfig } from "../yaml-io.js";
import { withAppLayer } from "../layer-build.js";
import { writeCurrentSession, clearCurrentSession } from "../current-session.js";
import { resolveServerUrl, serverFetch, ServerHttpError } from "../server-http.js";
import { formatRecoveryBlock } from "./recovery.js";
import { getOutputMode, emit } from "../output.js";

interface SessionCreateOptions {
  parent?: string;
  actor?: string;
}

interface SessionListOptions {
  status?: "active" | "paused" | "closed";
  actor?: string;
}

interface SessionResumeOptions {
  fork?: boolean;
  actor?: string;
  search?: string;
  serverUrl?: string;
}

interface SessionActorOnly {
  actor?: string;
}

/** Parse an `--actor "name:type"` string, falling back to the supplied defaults. */
const parseActor = (
  raw: string | undefined,
  defaultName: string,
  defaultType: ActorType,
): { name: string; type: ActorType } => {
  if (!raw) return { name: defaultName, type: defaultType };
  const idx = raw.lastIndexOf(":");
  if (idx < 0) {
    return { name: raw, type: defaultType };
  }
  const name = raw.slice(0, idx);
  const type = raw.slice(idx + 1) as ActorType;
  if (!VALID_ACTOR_TYPES.has(type)) {
    process.stderr.write(`cognit: --actor type must be one of human|worker|system, got: ${type}\n`);
    process.exitCode = 2;
    return { name: defaultName, type: defaultType };
  }
  return { name: name || defaultName, type };
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
    const paths = projectPaths(root);
    const cfg = yield* Effect.tryPromise({
      try: () => readConfig(paths.config),
      catch: (e) => new Error(`readConfig: ${(e as Error).message}`),
    });
    const projectService = yield* ProjectService;
    const row: ProjectRow = yield* projectService.ensure({ name: cfg.project.name });
    return { id: row.id, name: row.name };
  });

/**
 * Resolve a session ref (id or goal) to a session row. ULID-shaped
 * refs (`/^01[A-Z0-9]{22,}$/i`) are treated as ids; everything else is
 * a goal lookup via `getByGoalOrId` which prefers the most recent
 * match. Ambiguous matches print a warning to stderr.
 */
const resolveSessionRef = async (
  root: string,
  ref: string,
  projectId: string,
): Promise<SessionRow> => {
  const isLikelyId = /^01[A-Z0-9]{22,}$/i.test(ref);
  const program = Effect.gen(function* () {
    const service = yield* SessionService;
    if (isLikelyId) {
      return yield* service.getByGoalOrId({ projectId, id: ref });
    }
    return yield* service.getByGoalOrId({ projectId, goal: ref, preferMostRecent: true });
  });
  const exit = await Effect.runPromiseExit(
    withAppLayer(root, program) as Effect.Effect<unknown, unknown, never>,
  );
  if (Exit.isFailure(exit)) {
    const err = Cause.failureOption(exit.cause);
    if (err._tag === "Some") {
      const fail = err.value as { _tag?: string; attempted?: string };
      if (fail._tag === "UnknownGoalOrId") {
        process.stderr.write(`cognit: no session matches "${ref}"\n`);
      } else {
        process.stderr.write(`cognit: ${(fail as { message?: string }).message ?? String(fail)}\n`);
      }
    } else {
      process.stderr.write(`cognit: unexpected error resolving "${ref}"\n`);
    }
    process.exitCode = 1;
    throw new Error("resolveSessionRef: failed");
  }
  const result = exit.value as {
    session: SessionRow;
    matches: ReadonlyArray<SessionRow>;
    ambiguous: boolean;
  };
  if (result.ambiguous) {
    process.stderr.write(
      `cognit: warning — multiple sessions match "${ref}" (${result.matches.length}); using most recent. Re-run with the session id to disambiguate.\n`,
    );
  }
  return result.session;
};

const printSessionTable = (sessions: ReadonlyArray<SessionRow>): void => {
  if (sessions.length === 0) {
    process.stdout.write("(no sessions)\n");
    return;
  }
  // Compute max width per column for readable output. Goal is allowed
  // to truncate; everything else fits in the row.
  const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
  const header = ["ID", "STATUS", "GOAL", "CREATED_AT", "SNAPSHOTTED", "LAST_SNAPSHOT"];
  const snapshotted = sessions.map((s) => (s.last_snapshot_event_id ? "yes" : "no"));
  const rows = sessions.map((s, i) => [
    s.id,
    s.status,
    truncate(s.goal, 40),
    s.created_at,
    snapshotted[i] ?? "no",
    s.last_snapshot_event_id ?? "-",
  ]);
  // All rows have the same length as header
  process.stdout.write(header.join(" | ") + "\n");
  process.stdout.write(header.map((h) => "-".repeat(h.length)).join("-+-") + "\n");
  for (const r of rows) process.stdout.write(r.join(" | ") + "\n");
};

const printSessionShow = (result: SessionShowResult): void => {
  const s = result.session;
  process.stdout.write(`Session: ${s.id}\n`);
  process.stdout.write(`  status:                ${s.status}\n`);
  process.stdout.write(`  goal:                  ${s.goal}\n`);
  process.stdout.write(`  parent_session_id:     ${s.parent_session_id ?? "-"}\n`);
  process.stdout.write(`  created_at:            ${s.created_at}\n`);
  process.stdout.write(`  closed_at:             ${s.closed_at ?? "-"}\n`);
  process.stdout.write(
    `  last_snapshot_event_id:${s.last_snapshot_event_id ? " " + s.last_snapshot_event_id : " -"}\n`,
  );
  process.stdout.write(`  snapshot_event_id:     ${result.snapshot?.id ?? "-"}\n`);
  process.stdout.write(
    `  event_count:           ${result.snapshot?.event_count ?? result.tail_event_count}\n`,
  );
  process.stdout.write(`  tail_event_count:      ${result.tail_event_count}\n`);

  const st = result.state;

  const rejected = Array.from(st.hypotheses.values()).filter((h) => h.current_state === "rejected");
  if (rejected.length > 0) {
    process.stdout.write(`\nRejected hypotheses (${rejected.length}):\n`);
    for (const h of rejected) {
      process.stdout.write(`  - ${h.id}  ${h.title}\n`);
    }
  }

  const verified = Array.from(st.conclusions.values()).filter((c) => c.state === "verified");
  if (verified.length > 0) {
    process.stdout.write(`\nVerified conclusions (${verified.length}):\n`);
    for (const c of verified) {
      process.stdout.write(`  - ${c.id}  ${c.text}\n`);
    }
  }

  const accepted = Array.from(st.decisions.values()).filter((d) => d.state === "accepted");
  if (accepted.length > 0) {
    process.stdout.write(`\nAccepted decisions (${accepted.length}):\n`);
    for (const d of accepted) {
      process.stdout.write(`  - ${d.id}  ${d.text}\n`);
    }
  }

  if (st.observations.length > 0) {
    const last = st.observations.slice(-5);
    process.stdout.write(`\nObservations (last ${last.length} of ${st.observations.length}):\n`);
    for (const o of last) {
      process.stdout.write(`  - ${o.created_at}  ${o.text}\n`);
    }
  }

  if (st.findings.length > 0) {
    const last = st.findings.slice(-5);
    process.stdout.write(`\nFindings (last ${last.length} of ${st.findings.length}):\n`);
    for (const f of last) {
      process.stdout.write(`  - ${f.created_at}  ${f.text}\n`);
    }
  }

  // Phase 4 / 6bz.3: surface verifications (state + stdout_excerpt).
  // `st.verifications` is a Map<id, VerificationState>; print the
  // most recent 5 in insertion order so the operator can see whether
  // the latest verify run passed/failed/errored at a glance.
  const verifs = Array.from((st.verifications as ReadonlyMap<string, {
    readonly id: string;
    readonly command: string;
    readonly type: string;
    readonly state: string;
    readonly exit_code: number | null;
    readonly duration_ms: number | null;
    readonly stdout_excerpt: string | null;
    readonly stderr_excerpt: string | null;
    readonly error: string | null;
  }>).values());
  if (verifs.length > 0) {
    const last = verifs.slice(-5);
    process.stdout.write(`\nVerifications (last ${last.length} of ${verifs.length}):\n`);
    for (const v of last) {
      const excerpt =
        v.state === "failed"
          ? (v.stderr_excerpt ?? "").slice(0, 80)
          : (v.stdout_excerpt ?? "").slice(0, 80);
      process.stdout.write(
        `  - ${v.id}  ${v.type}  ${v.state}` +
          (v.exit_code !== null ? `  exit=${v.exit_code}` : "") +
          (v.duration_ms !== null ? `  ${v.duration_ms}ms` : "") +
          (excerpt ? `  | ${excerpt}` : "") +
          "\n",
      );
    }
  }

  if (st.timeline.length > 0) {
    const last = st.timeline.slice(-10);
    process.stdout.write(`\nTimeline (last ${last.length} of ${st.timeline.length} events):\n`);
    for (const ev of last) {
      const payload = (ev.payload_json ?? "").slice(0, 80);
      process.stdout.write(`  - ${ev.created_at}  ${ev.type}  ${payload}\n`);
    }
  }
};

// Run an Effect that depends on the app layer, providing the layer
// built from `root`. Catches and logs failures with the canonical
// "cognit:" prefix and sets a non-zero exit code. The caller passes
// an Effect whose R-channel is satisfied by the app layer; we wrap
// it in `withAppLayer` here so the command bodies don't have to.
const runCommand = <A, E, R>(root: string, eff: Effect.Effect<A, E, R>): Promise<A> => {
  // Provide the app layer. The effect's R-channel is partially
  // stripped by `withAppLayer`; the cast lets us run it.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const provided = withAppLayer(root, eff) as any as Effect.Effect<A, E, never>;
  return Effect.runPromise(provided).catch((e: unknown) => {
    if (process.exitCode === undefined) process.exitCode = 1;
    process.stderr.write(`cognit: ${(e as Error).message ?? String(e)}\n`);
    throw e;
  });
};

export function registerSession(program: Command): void {
  const session = program
    .command("session")
    .description("manage sessions: create, list, show, resume, pause, close");

  session
    .command("create <goal>")
    .description("create a new session for the current project")
    .option("--parent <id>", "parent session id (forked sessions)")
    .option("--actor <name:type>", 'actor override (default "cognit-cli:system")')
    .action(async (goal: string, opts: SessionCreateOptions) => {
      const root = requireProjectRoot();
      const project = await loadProject(root);
      const actor = parseActor(opts.actor, "cognit-cli", "system");
      await runCommand(
        root,
        Effect.gen(function* () {
          const service = yield* SessionService;
          const r = yield* service.create({
            projectId: project.id,
            goal,
            parentSessionId: opts.parent ?? null,
            actor,
          });
          process.stdout.write(`session: ${r.session.id}\n`);
          process.stdout.write(`goal:    ${r.session.goal}\n`);
          process.stdout.write(`status:  ${r.session.status}\n`);
          // Phase 3b: sticky session pointer. Atomic rename inside
          // the helper; the create succeeded even if this write fails,
          // so we don't fail the command — the pointer is a
          // convenience, not a contract.
          try {
            writeCurrentSession(root, r.session.id);
          } catch (e) {
            process.stderr.write(
              `cognit: warning — failed to write sticky session pointer: ${(e as Error).message}\n`,
            );
          }
        }),
      );
    });

  session
    .command("list")
    .description("list sessions for the current project")
    .option("--status <s>", "filter by status (active|paused|closed)")
    .option("--actor <name:type>", "actor override (unused, accepted for symmetry)")
    .action(async (opts: SessionListOptions) => {
      const root = requireProjectRoot();
      const project = await loadProject(root);
      const status = opts.status as "active" | "paused" | "closed" | undefined;
      if (status && !["active", "paused", "closed"].includes(status)) {
        process.stderr.write(`cognit: --status must be one of active|paused|closed\n`);
        process.exitCode = 2;
        return;
      }
      await runCommand(
        root,
        Effect.gen(function* () {
          const service = yield* SessionService;
          const q: { projectId: string; status?: "active" | "paused" | "closed" } = {
            projectId: project.id,
          };
          if (status) q.status = status;
          const rows = yield* service.list(q);
          if (getOutputMode() === "json") {
            emit("json", "session.list", rows);
          } else {
            printSessionTable(rows);
          }
        }),
      );
    });

  session
    .command("show <ref>")
    .description("show session details (accepts id or goal)")
    .action(async (ref: string) => {
      const root = requireProjectRoot();
      const project = await loadProject(root);
      const sessionRow = await resolveSessionRef(root, ref, project.id);
      const program = Effect.gen(function* () {
        const service = yield* SessionService;
        const r = yield* service.show(sessionRow.id);
        if (getOutputMode() === "json") {
          emit("json", "session.show", r);
        } else {
          printSessionShow(r);
        }
      });
      await runCommand(root, program);
    });

  session
    .command("resume <ref>")
    .description("resume a session (default forks; pass --fork=false to reopen)")
    .option("--fork <bool>", "fork into a new session (default: true)")
    .option("--actor <name:type>", 'actor override (default "cognit-cli:system")')
    .option("--search <query>", "fuzzy-match open sessions by goal and pick most recent")
    .option("--server-url <url>", "server base URL for --search and recovery (default: $COGNIT_SERVER_URL or http://127.0.0.1:6971)")
    .action(async (ref: string, opts: SessionResumeOptions) => {
      const root = requireProjectRoot();
      const project = await loadProject(root);
      const actor = parseActor(opts.actor, "cognit-cli", "system");
      // commander parses --fork as string; truthy values = true.
      let fork = true;
      if (opts.fork !== undefined) {
        fork = !["false", "0", "no"].includes(String(opts.fork).toLowerCase());
      }
      // Resolve the target session. When --search is given, hit the
      // fuzzy search endpoint and pick the most-recent active session
      // from the ranked results. AC-7.14: multiple ambiguous hits
      // (same goal text) print a warning to stderr but still proceed
      // with the most-recent by created_at.
      let targetRef = ref;
      if (opts.search !== undefined && opts.search.length > 0) {
        const base = resolveServerUrl({ serverUrl: opts.serverUrl });
        const qs = new URLSearchParams({ q: opts.search, status: "active" });
        const env = (await serverFetch(base, `/api/sessions/search?${qs.toString()}`)) as
          | { data?: { results?: ReadonlyArray<{ session_id: string; kind: string }> } }
          | null;
        const data = env?.data ?? {};
        const hits = Array.isArray(data.results) ? data.results : [];
        if (hits.length === 0) {
          process.stderr.write(`cognit: no matching session\n`);
          process.exitCode = 1;
          return;
        }
        // Group by session_id keeping the lowest-ranked (best) entry,
        // then fetch each candidate's created_at via SessionService so
        // we can pick the most recent.
        const bySession = new Map<string, { sessionId: string; kind: string }>();
        for (const h of hits) {
          if (!bySession.has(h.session_id)) bySession.set(h.session_id, { sessionId: h.session_id, kind: h.kind });
        }
        const candidates = Array.from(bySession.values());
        const program = Effect.gen(function* () {
          const service = yield* SessionService;
          const rows: Array<SessionRow> = [];
          for (const c of candidates) {
            const r = yield* service.show(c.sessionId);
            rows.push(r.session);
          }
          return rows.sort((a, b) => b.created_at.localeCompare(a.created_at));
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const sorted = (await Effect.runPromise(withAppLayer(root, program) as any)) as ReadonlyArray<SessionRow>;
        if (sorted.length === 0) {
          process.stderr.write(`cognit: no matching session\n`);
          process.exitCode = 1;
          return;
        }
        if (sorted.length > 1) {
          process.stderr.write(
            `cognit: warning — ${sorted.length} sessions match --search "${opts.search}"; resuming the most recent.\n`,
          );
        }
        const mostRecent = sorted[0]!;
        targetRef = mostRecent.id;
      }
      // We need the row, not just an id, to pass idOrGoal through the
      // service. But the service's `resume` handles that for us, so
      // we can pass the ref as-is.
      let resumedId = targetRef;
      await runCommand(
        root,
        Effect.gen(function* () {
          const service = yield* SessionService;
          const r = yield* service.resume({
            projectId: project.id,
            idOrGoal: targetRef,
            fork,
            actor,
          });
          process.stdout.write(`session:    ${r.session.id}\n`);
          process.stdout.write(`parent:     ${r.parent.id}\n`);
          process.stdout.write(`forked:     ${r.forked ? "yes (new session)" : "no (reopened)"}\n`);
          process.stdout.write(`status:     ${r.session.status}\n`);
          process.stdout.write(`goal:       ${r.session.goal}\n`);
          resumedId = r.session.id;
          // Phase 3b: resume updates the sticky pointer to the new
          // (possibly forked) session id. Same try/catch semantics as
          // create: pointer is convenience, not contract.
          try {
            writeCurrentSession(root, r.session.id);
          } catch (e) {
            process.stderr.write(
              `cognit: warning — failed to write sticky session pointer: ${(e as Error).message}\n`,
            );
          }
        }),
      );
      // AC-7.13: print a 3-field minimum recovery block after every
      // successful resume. Best-effort: a server outage should not
      // turn a successful resume into a non-zero exit.
      //
      // AC-8.12 / AC-8.14 (phase 8 — 8g.4): if `suggested_next_steps`
      // is populated (recovery surface filled top-1 active hypothesis),
      // print one extra "Suggested next step:" line BEFORE the recovery
      // block so it leads the human's eye. Suppress when empty.
      try {
        const base = resolveServerUrl({ serverUrl: opts.serverUrl });
        const env = (await serverFetch(
          base,
          `/api/sessions/${encodeURIComponent(resumedId)}/recovery`,
        )) as { data?: Record<string, unknown> } | null;
        const data = env?.data;
        if (data !== undefined && data !== null) {
          const steps = Array.isArray(data["suggested_next_steps"])
            ? (data["suggested_next_steps"] as ReadonlyArray<unknown>)
            : [];
          const top = steps[0];
          if (top !== undefined && top !== null && typeof top === "object") {
            const t = top as Record<string, unknown>;
            const id = typeof t["id"] === "string" ? (t["id"] as string) : "";
            const text = typeof t["text"] === "string" ? (t["text"] as string) : "";
            const score =
              typeof t["score"] === "number" ? (t["score"] as number).toFixed(3) : "-";
            if (id || text) {
              process.stdout.write(
                `Suggested next step: ${text}  (gravity: ${score}, id: ${id})\n`,
              );
            }
          }
          process.stdout.write(formatRecoveryBlock(data));
        }
      } catch (e) {
        if (e instanceof ServerHttpError) {
          process.stderr.write(
            `cognit: warning — could not fetch recovery block: ${e.status} ${e.url}\n`,
          );
        } else {
          process.stderr.write(
            `cognit: warning — could not fetch recovery block: ${(e as Error).message ?? String(e)}\n`,
          );
        }
      }
    });

  session
    .command("pause <ref>")
    .description("pause an active session")
    .option("--actor <name:type>", 'actor override (default "cognit-cli:system")')
    .action(async (ref: string, opts: SessionActorOnly) => {
      const root = requireProjectRoot();
      const project = await loadProject(root);
      const actor = parseActor(opts.actor, "cognit-cli", "system");
      const sessionRow = await resolveSessionRef(root, ref, project.id);
      await runCommand(
        root,
        Effect.gen(function* () {
          const service = yield* SessionService;
          const r = yield* service.pause(sessionRow.id, actor);
          process.stdout.write(`session: ${r.session.id}\n`);
          process.stdout.write(`status:  ${r.session.status}\n`);
        }),
      );
    });

  session
    .command("close <ref>")
    .description("close a session (writes a snapshot)")
    .option("--actor <name:type>", 'actor override (default "cognit-cli:system")')
    .action(async (ref: string, opts: SessionActorOnly) => {
      const root = requireProjectRoot();
      const project = await loadProject(root);
      const actor = parseActor(opts.actor, "cognit-cli", "system");
      const sessionRow = await resolveSessionRef(root, ref, project.id);
      await runCommand(
        root,
        Effect.gen(function* () {
          const service = yield* SessionService;
          const r = yield* service.close(sessionRow.id, actor);
          process.stdout.write(`session:    ${r.session.id}\n`);
          process.stdout.write(`status:     ${r.session.status}\n`);
          process.stdout.write(`closed_at:  ${r.session.closed_at ?? "-"}\n`);
          // Best-effort: print the snapshot id if one exists. The
          // close path always runs SnapshotService.write, so the
          // sessions row's last_snapshot_event_id is the pointer.
          const snapId = r.session.last_snapshot_event_id ?? "-";
          process.stdout.write(`snapshot:   ${snapId}\n`);
          // Phase 3b: close clears the sticky pointer so a subsequent
          // `cognit append` (no --session) does not silently land in
          // a closed session. Idempotent on a missing file.
          try {
            clearCurrentSession(root);
          } catch (e) {
            process.stderr.write(
              `cognit: warning — failed to clear sticky session pointer: ${(e as Error).message}\n`,
            );
          }
        }),
      );
    });
}
