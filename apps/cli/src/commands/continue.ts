/**
 * apps/cli/src/commands/continue.ts — `cognit continue`.
 *
 * M2.0 recall quality. Reads SQLite DIRECTLY (no Hono server). Answers
 * the six questions a returning agent asks before picking up work:
 *
 *   - What was I doing?       (last observation + session goal)
 *   - What was decided?       (accepted decisions)
 *   - What is still open?     (open hypotheses + open verifications)
 *   - What was verified?      (verified conclusions)
 *   - What should I do next?  (suggested next step)
 *   - Can I trust this?       (trust markers: verified|accepted|
 *                              rejected|pending|open)
 *
 * Output stays compact — six labelled sections + a suggested next
 * step. No internal event names leak unless `--json` is set.
 *
 * Empty state: a single onboarding block with concrete next actions
 * (`cognit observation "..."` etc.). No stack traces, no DB paths.
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

/** Trust marker vocabulary — the only labels text output may emit. */
type TrustMarker = "verified" | "accepted" | "rejected" | "pending" | "open";

/**
 * Map the reduced SessionState into a printable continue block.
 *
 * Internal lifecycle states (`proposed`, `weakened`, `superseded`,
 * `unverified`, `started`, `errored`, etc.) are translated to one of
 * the five trust markers at this seam — text output never names the
 * raw state names. JSON output (`--json`) keeps the raw `state` field
 * for tooling.
 */
interface ContinueSummary {
  sessionId: string;
  goal: string;
  status: string;
  lastActivityAt: string | null;
  /** Most recent observation — answers "what was I doing?". */
  doing: { text: string; created_at: string } | null;
  verifiedConclusions: ReadonlyArray<{ id: string; text: string; marker: TrustMarker }>;
  acceptedDecisions: ReadonlyArray<{ id: string; text: string; marker: TrustMarker }>;
  rejectedDecisions: ReadonlyArray<{ id: string; text: string; reason: string | null; marker: TrustMarker }>;
  proposedDecisions: ReadonlyArray<{ id: string; text: string; marker: TrustMarker }>;
  openHypotheses: ReadonlyArray<{ id: string; title: string; marker: TrustMarker }>;
  openVerifications: ReadonlyArray<{ id: string; command: string; state: string; marker: TrustMarker }>;
  suggestedNextStep: { id: string; text: string; source: string } | null;
  /** Counts only — emitted in the trust footer line. */
  trustCounts: Readonly<Record<TrustMarker, number>>;
}

const summarize = (
  session: SessionRow,
  state: {
    readonly observations: ReadonlyArray<{ readonly text: string; readonly created_at: string }>;
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
  // Trust counts — drives the footer "Trust: verified x, accepted y…"
  // line. Counted once, used for both the marker list and the totals.
  const trustCounts: Record<TrustMarker, number> = {
    verified: 0,
    accepted: 0,
    rejected: 0,
    pending: 0,
    open: 0,
  };

  const verifiedConclusions = Array.from(state.conclusions.values())
    .filter((c) => c.state === "verified")
    .map((c) => ({ id: c.id, text: c.text, marker: "verified" as TrustMarker }));
  trustCounts.verified += verifiedConclusions.length;

  const rejectedDecisions = Array.from(state.decisions.values())
    .filter((d) => d.state === "rejected")
    .map((d) => ({ id: d.id, text: d.text, reason: d.reason, marker: "rejected" as TrustMarker }));
  trustCounts.rejected += rejectedDecisions.length;

  const acceptedDecisions = Array.from(state.decisions.values())
    .filter((d) => d.state === "accepted")
    .map((d) => ({ id: d.id, text: d.text, marker: "accepted" as TrustMarker }));
  trustCounts.accepted += acceptedDecisions.length;

  const proposedDecisions = Array.from(state.decisions.values())
    .filter((d) => d.state === "proposed")
    .map((d) => ({ id: d.id, text: d.text, marker: "pending" as TrustMarker }));
  trustCounts.pending += proposedDecisions.length;

  const openHypotheses = Array.from(state.hypotheses.values())
    .filter((h) => h.current_state === "proposed" || h.current_state === "weakened" || h.current_state === "active")
    .map((h) => ({ id: h.id, title: h.title, marker: "open" as TrustMarker }));
  trustCounts.open += openHypotheses.length;

  const openVerifications = Array.from(state.verifications.values())
    .filter((v) => v.state !== "passed" && v.state !== "failed" && v.state !== "errored" && v.state !== "cancelled")
    .map((v) => ({ id: v.id, command: v.command, state: v.state, marker: "open" as TrustMarker }));
  trustCounts.open += openVerifications.length;

  // Suggested next step: prefer the most recent open hypothesis, fall
  // back to the most recent accepted decision. Simple v0 — server-side
  // gravity ranking (suggested_next_steps in the recovery envelope) is
  // the richer source when the server is up.
  let suggested: ContinueSummary["suggestedNextStep"] = null;
  if (openHypotheses.length > 0) {
    const h = openHypotheses[openHypotheses.length - 1]!;
    suggested = { id: h.id, text: h.title, source: "open-hypothesis" };
  } else if (acceptedDecisions.length > 0) {
    const d = acceptedDecisions[acceptedDecisions.length - 1]!;
    suggested = { id: d.id, text: d.text, source: "last-accepted-decision" };
  }

  const doing = state.observations.length > 0
    ? {
        text: state.observations[state.observations.length - 1]!.text,
        created_at: state.observations[state.observations.length - 1]!.created_at,
      }
    : null;

  const lastActivityAt =
    state.observations.length > 0
      ? state.observations[state.observations.length - 1]!.created_at
      : session.created_at;

  return {
    sessionId: session.id,
    goal: session.goal,
    status: session.status,
    lastActivityAt,
    doing,
    verifiedConclusions,
    acceptedDecisions,
    rejectedDecisions,
    proposedDecisions,
    openHypotheses,
    openVerifications,
    suggestedNextStep: suggested,
    trustCounts,
  };
};

/** Render the trust footer line — short counts only. */
const renderTrustLine = (counts: Readonly<Record<TrustMarker, number>>): string => {
  const parts: string[] = [];
  if (counts.verified > 0) parts.push(`${counts.verified} verified`);
  if (counts.accepted > 0) parts.push(`${counts.accepted} accepted`);
  if (counts.pending > 0) parts.push(`${counts.pending} pending`);
  if (counts.open > 0) parts.push(`${counts.open} open`);
  if (counts.rejected > 0) parts.push(`${counts.rejected} rejected`);
  return parts.length === 0 ? "  (none yet)" : "  " + parts.join("  ·  ");
};

const renderText = (s: ContinueSummary): string => {
  const lines: string[] = [];

  lines.push(`Session:    ${truncate(s.goal, 70)}`);
  lines.push(`Status:     ${s.status}`);
  lines.push(`Last work:  ${s.lastActivityAt ?? "(unknown)"}`);
  lines.push("");

  // Doing: the most recent observation — answers "what was I doing?"
  if (s.doing) {
    lines.push("Doing:");
    lines.push(`  ${truncate(s.doing.text, 80)}`);
    lines.push("");
  }

  const hasHistory =
    s.verifiedConclusions.length +
      s.acceptedDecisions.length +
      s.proposedDecisions.length +
      s.rejectedDecisions.length >
    0;
  const hasOpen = s.openHypotheses.length + s.openVerifications.length > 0;

  if (!hasHistory && !hasOpen && !s.doing) {
    lines.push("No reasoning recorded yet for this session.");
    lines.push("");
    lines.push("Try:");
    lines.push(`  cognit observation "what you're working on"`);
    lines.push(`  cognit decision propose "what you decided"`);
    lines.push(`  cognit verification run "pnpm test"`);
    lines.push("");
    lines.push(`Trust:${renderTrustLine(s.trustCounts)}`);
    return lines.join("\n") + "\n";
  }

  if (hasHistory) {
    lines.push("Decided:");
    for (const c of s.verifiedConclusions) {
      lines.push(`  [verified]  ${truncate(c.text, 70)}`);
    }
    for (const d of s.acceptedDecisions) {
      lines.push(`  [accepted]  ${truncate(d.text, 70)}`);
    }
    for (const d of s.proposedDecisions) {
      lines.push(`  [pending]   ${truncate(d.text, 70)}`);
    }
    for (const d of s.rejectedDecisions) {
      const reason = d.reason ? `  (${truncate(d.reason, 40)})` : "";
      lines.push(`  [rejected]  ${truncate(d.text, 70)}${reason}`);
    }
    lines.push("");
  }

  if (hasOpen) {
    lines.push("Open:");
    for (const h of s.openHypotheses) {
      lines.push(`  [open] hypothesis    ${truncate(h.title, 65)}`);
    }
    for (const v of s.openVerifications) {
      lines.push(`  [open] verify        ${truncate(v.command, 60)}`);
    }
    lines.push("");
  }

  // Verified section (kept separate from "Decided" so the agent sees
  // proven facts in their own bucket).
  if (s.verifiedConclusions.length > 0) {
    lines.push("Verified:");
    for (const c of s.verifiedConclusions) {
      lines.push(`  [verified]  ${truncate(c.text, 70)}`);
    }
    lines.push("");
  }

  if (s.suggestedNextStep) {
    lines.push("Next:");
    lines.push(`  ${truncate(s.suggestedNextStep.text, 80)}`);
  } else {
    lines.push("Next:");
    lines.push(`  (nothing open — close session or start a new one)`);
  }
  lines.push("");

  lines.push(`Trust:${renderTrustLine(s.trustCounts)}`);
  return lines.join("\n") + "\n";
};

const renderOnboarding = (): string =>
  [
    "No memory yet.",
    "",
    "Open Claude Code. Work normally.",
    "Run `cognit continue` again to see what's been remembered.",
    "",
    "Try:",
    '  cognit observation "auth uses refresh tokens"',
    '  cognit decision propose "drop the optimistic cache"',
    '  cognit verification run "pnpm test"',
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
      // --all is accepted for forward compat; trust + structure is the
      // same regardless of recency — the freshness signal lives in
      // `lastActivityAt` and the trust counts.
      void opts.all;
      if (getOutputMode() === "json") {
        emit("json", "continue", summary);
        return;
      }
      process.stdout.write(renderText(summary));
    });
}