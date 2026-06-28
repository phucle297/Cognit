/**
 * apps/cli/src/commands/continue.ts — `cognit continue`.
 *
 * M1 daily entry point. Reads the SQLite database DIRECTLY (no Hono
 * server required). Outputs:
 *
 *   Yesterday:
 *     ✓ <verified conclusion text>
 *     ✗ <rejected hypothesis title>
 *     • <accepted decision text>
 *
 *   Open:
 *     • <open hypothesis title>
 *     • <open verification>
 *
 *   Suggested next step: <top open hypothesis or most recent decision>
 *
 * If the user has no sessions yet, prints an onboarding block:
 *
 *   No memory yet.
 *   Open Claude Code. Work normally.
 *   Run `cognit continue` again to see what's been remembered.
 *
 * The contract: never blocks on a missing server. Reads SQLite via
 * withAppLayer (the same path every command uses), folds events into
 * a SessionState, and prints.
 */
import { Command } from "commander";
import { Effect, Exit, Cause } from "effect";
import {
  ProjectService,
  SessionService,
  type SessionRow,
} from "@cognit/db";
import { findProjectRoot, projectPaths } from "../paths.js";
import { readConfig } from "../yaml-io.js";
import { withAppLayer } from "../layer-build.js";
import { getOutputMode, emit } from "../output.js";
import { requireProjectRoot } from "../auto-session.js";
import { readCurrentSession, writeCurrentSession } from "../current-session.js";

const DAY_MS = 24 * 60 * 60 * 1000;

interface ContinueOptions {
  root?: string;
  /** Show only the last 24h (default true). */
  recent?: boolean;
}

const truncate = (s: string, n: number): string =>
  s.length > n ? s.slice(0, n - 1) + "…" : s;

const pad = (s: string, n: number): string =>
  s.length >= n ? s : s + " ".repeat(n - s.length);

/**
 * Map the reduced SessionState into a printable continue block.
 */
interface ContinueSummary {
  sessionId: string;
  goal: string;
  status: string;
  lastActivityAt: string | null;
  verifiedConclusions: ReadonlyArray<{ id: string; text: string }>;
  rejectedHypotheses: ReadonlyArray<{ id: string; title: string }>;
  acceptedDecisions: ReadonlyArray<{ id: string; text: string }>;
  rejectedDecisions: ReadonlyArray<{ id: string; text: string; reason: string | null }>;
  proposedDecisions: ReadonlyArray<{ id: string; text: string }>;
  openHypotheses: ReadonlyArray<{ id: string; title: string }>;
  openVerifications: ReadonlyArray<{ id: string; command: string; state: string }>;
  suggestedNextStep: { id: string; text: string; source: string } | null;
}

const summarize = (
  session: SessionRow,
  state: {
    readonly observations: ReadonlyArray<{ readonly created_at: string }>;
    readonly hypotheses: ReadonlyMap<
      string,
      {
        readonly id: string;
        readonly title: string;
        readonly current_state: string;
        readonly last_updated_at: string | null;
      }
    >;
    readonly decisions: ReadonlyMap<
      string,
      {
        readonly id: string;
        readonly text: string;
        readonly state: string;
        readonly last_updated_at: string | null;
        readonly reason: string | null;
      }
    >;
    readonly conclusions: ReadonlyMap<
      string,
      { readonly id: string; readonly text: string; readonly state: string }
    >;
    readonly verifications: ReadonlyMap<
      string,
      {
        readonly id: string;
        readonly command: string;
        readonly state: string;
        readonly last_updated_at: string | null;
      }
    >;
  },
): ContinueSummary => {
  const verifiedConclusions = Array.from(state.conclusions.values())
    .filter((c) => c.state === "verified")
    .map((c) => ({ id: c.id, text: c.text }));

  const rejectedHypotheses = Array.from(state.hypotheses.values())
    .filter((h) => h.current_state === "rejected")
    .map((h) => ({ id: h.id, title: h.title }));

  const acceptedDecisions = Array.from(state.decisions.values())
    .filter((d) => d.state === "accepted")
    .map((d) => ({ id: d.id, text: d.text }));

  const rejectedDecisions = Array.from(state.decisions.values())
    .filter((d) => d.state === "rejected")
    .map((d) => ({ id: d.id, text: d.text, reason: d.reason }));

  const proposedDecisions = Array.from(state.decisions.values())
    .filter((d) => d.state === "proposed")
    .map((d) => ({ id: d.id, text: d.text }));

  const openHypotheses = Array.from(state.hypotheses.values())
    .filter((h) => h.current_state === "proposed" || h.current_state === "weakened")
    .map((h) => ({ id: h.id, title: h.title }));

  const openVerifications = Array.from(state.verifications.values())
    .filter((v) => v.state !== "passed" && v.state !== "failed" && v.state !== "errored" && v.state !== "cancelled")
    .map((v) => ({ id: v.id, command: v.command, state: v.state }));

  // Suggested next step: prefer the most recent open hypothesis, fall
  // back to the most recent accepted decision. This is the simple
  // v0; the server-side gravity ranking (suggested_next_steps in the
  // recovery envelope) is the richer source when the server is up.
  let suggested: ContinueSummary["suggestedNextStep"] = null;
  if (openHypotheses.length > 0) {
    const h = openHypotheses[openHypotheses.length - 1]!;
    suggested = { id: h.id, text: h.title, source: "open-hypothesis" };
  } else if (acceptedDecisions.length > 0) {
    const d = acceptedDecisions[acceptedDecisions.length - 1]!;
    suggested = { id: d.id, text: d.text, source: "last-accepted-decision" };
  }

  const lastActivityAt =
    state.observations.length > 0
      ? state.observations[state.observations.length - 1]!.created_at
      : session.created_at;

  return {
    sessionId: session.id,
    goal: session.goal,
    status: session.status,
    lastActivityAt,
    verifiedConclusions,
    rejectedHypotheses,
    acceptedDecisions,
    rejectedDecisions,
    proposedDecisions,
    openHypotheses,
    openVerifications,
    suggestedNextStep: suggested,
  };
};

const renderText = (s: ContinueSummary, sinceMs: number): string => {
  const lines: string[] = [];
  const cutoffIso = new Date(sinceMs).toISOString();
  const recent = (iso: string | null): boolean =>
    iso !== null && iso >= cutoffIso;

  lines.push(`Session:    ${truncate(s.goal, 70)}`);
  lines.push(`Status:     ${s.status}`);
  lines.push(`Last work:  ${s.lastActivityAt ?? "(unknown)"}`);
  lines.push("");

  const verified = s.verifiedConclusions.filter((c) => recent(null));
  const accepted = s.acceptedDecisions;
  const proposed = s.proposedDecisions;
  const rejectedH = s.rejectedHypotheses;
  const rejectedD = s.rejectedDecisions;

  const hasHistory =
    verified.length + accepted.length + proposed.length + rejectedH.length + rejectedD.length > 0;
  const hasOpen = s.openHypotheses.length + s.openVerifications.length > 0;

  if (!hasHistory && !hasOpen) {
    lines.push("No reasoning recorded yet for this session.");
    return lines.join("\n") + "\n";
  }

  if (hasHistory) {
    lines.push("What was decided:");
    for (const c of verified) {
      lines.push(`  ✓ ${pad("verified", 10)} ${truncate(c.text, 70)}`);
    }
    for (const d of accepted) {
      lines.push(`  • ${pad("accepted", 10)} ${truncate(d.text, 70)}`);
    }
    for (const d of proposed) {
      lines.push(`  ◦ ${pad("proposed", 10)} ${truncate(d.text, 70)}`);
    }
    for (const h of rejectedH) {
      lines.push(`  ✗ ${pad("rejected", 10)} ${truncate(h.title, 70)}`);
    }
    for (const d of rejectedD) {
      const reason = d.reason ? ` (${truncate(d.reason, 40)})` : "";
      lines.push(`  ✗ ${pad("rejected", 10)} ${truncate(d.text, 70)}${reason}`);
    }
    lines.push("");
  }

  if (hasOpen) {
    lines.push("Open:");
    for (const h of s.openHypotheses) {
      lines.push(`  • hypothesis   ${truncate(h.title, 70)}`);
    }
    for (const v of s.openVerifications) {
      lines.push(`  • verify (${pad(v.state, 9)}) ${truncate(v.command, 60)}`);
    }
    lines.push("");
  }

  if (s.suggestedNextStep) {
    lines.push(`Suggested next step:`);
    lines.push(`  ${truncate(s.suggestedNextStep.text, 80)}`);
    lines.push(`  (source: ${s.suggestedNextStep.source})`);
  }
  return lines.join("\n") + "\n";
};

const renderOnboarding = (): string =>
  [
    "No memory yet.",
    "",
    "Open Claude Code. Work normally.",
    "Run `cognit continue` again to see what's been remembered.",
    "",
    "Tip: from inside Claude Code, run",
    "  cognit observation \"...\"",
    "  cognit decision propose \"...\"",
    "  cognit verification run \"pnpm test\"",
    "to write memory as you go.",
    "",
  ].join("\n");

export function registerContinue(program: Command): void {
  program
    .command("continue")
    .description(
      "summarise the active session so the next AI can pick up where the last one stopped",
    )
    .option("--root <path>", "project root (defaults to nearest .cognit/cognit.yaml)")
    .option(
      "--all",
      "show the full history, not just the last 24h (default: last 24h only)",
    )
    .action(async (opts: ContinueOptions) => {
      const root = opts.root ?? requireProjectRoot();

      // Resolve project + most-recent session via direct SQLite.
      const exit = await Effect.runPromiseExit(
        withAppLayer(
          root,
          Effect.gen(function* () {
            const cfg = yield* Effect.tryPromise({
              try: () => readConfig(projectPaths(root).config),
              catch: (e) => new Error(`readConfig: ${(e as Error).message}`),
            });
            const projects = yield* ProjectService;
            const project = yield* projects.ensure({ name: cfg.project.name });

            const sessions = yield* SessionService;

            // Prefer the sticky pointer if it points at an open session.
            const pointer = readCurrentSession(root);
            let target: SessionRow | null = null;
            if (pointer) {
              try {
                const r = yield* sessions.show(pointer.sessionId);
                if (r.session.status !== "closed") target = r.session;
              } catch (_e) {
                /* stale pointer; fall through */
              }
            }
            if (!target) {
              // Otherwise: most recent active or paused session for the project.
              const list = yield* sessions.list({ projectId: project.id });
              const candidates = list
                .filter((s) => s.status !== "closed")
                .sort((a, b) => b.created_at.localeCompare(a.created_at));
              target = candidates[0] ?? null;
            }
            if (!target) {
              // Last resort: most recent of any status.
              const list = yield* sessions.list({ projectId: project.id });
              const sorted = [...list].sort((a, b) =>
                b.created_at.localeCompare(a.created_at),
              );
              target = sorted[0] ?? null;
            }
            if (!target) return null;

            const show = yield* sessions.show(target.id);
            // Update sticky pointer so subsequent calls stay sticky.
            writeCurrentSession(root, show.session.id);
            return { row: show.session, state: show.state };
          }),
        ),
      );

      if (Exit.isFailure(exit)) {
        const cause = Cause.failureOption(exit.cause);
        const msg =
          cause._tag === "Some"
            ? ((cause.value as { message?: string }).message ?? String(cause.value))
            : "continue failed";
        process.stderr.write(`cognit: ${msg}\n`);
        process.exitCode = 1;
        return;
      }

      if (exit.value === null) {
        if (getOutputMode() === "json") {
          emit("json", "continue", { empty: true });
        } else {
          process.stdout.write(renderOnboarding());
        }
        return;
      }

      const { row, state } = exit.value as {
        row: SessionRow;
        state: Parameters<typeof summarize>[1];
      };
      const summary = summarize(row, state);
      const sinceMs = opts.all ? 0 : Date.now() - DAY_MS;
      if (getOutputMode() === "json") {
        emit("json", "continue", summary);
        return;
      }
      process.stdout.write(renderText(summary, sinceMs));
    });
}
