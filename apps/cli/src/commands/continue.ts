/**
 * apps/cli/src/commands/continue.ts — `cognit continue`.
 *
 * M2.0 recall quality + M2.1 memory selection. Reads SQLite DIRECTLY
 * (no Hono server). Answers the six questions a returning agent
 * asks before picking up work:
 *
 *   - What was I doing?       (last observation)
 *   - What was decided?       (top accepted decisions)
 *   - What is still open?     (top open hypotheses + verifications)
 *   - What was verified?      (top verified conclusions)
 *   - What should I do next?  (suggested next step)
 *   - Can I trust this?       (trust markers: verified|accepted|
 *                              rejected|pending|open)
 *
 * M2.1 selection rules:
 *   - rank every decision/conclusion/hypothesis/verification with
 *     the deterministic scorer in @cognit/core/ranking
 *   - collapse duplicates, prefer verified > newer > accepted
 *   - cap per kind (top-3 decisions, top-3 conclusions, top-3
 *     hypotheses, top-2 verifications)
 *   - render ✓ bullets per memory so the agent sees WHY each was
 *     selected — never a bare score
 *
 * Output stays compact — labelled sections + a suggested next step.
 * No internal event names leak unless `--json` is set.
 *
 * Empty state: a single onboarding block with concrete next actions
 * (`cognit observation "..."` etc.). No stack traces, no DB paths.
 */
import { Command } from "commander";
import { Effect, Exit, Cause } from "effect";
import { ProjectService, SessionService, type SessionRow } from "@cognit/db";
import {
  DEFAULT_CONTINUE_CAPS,
  deduplicateMemories,
  topNByKind,
  rankSessionMemories,
  type RankedMemory,
} from "@cognit/core/ranking";
import { projectPaths } from "../paths.js";
import { readConfig } from "../yaml-io.js";
import { withAppLayer } from "../layer-build.js";
import { getOutputMode, emit } from "../output.js";
import { requireProjectRoot } from "../auto-session.js";
import { drainInboxOnce } from "../inbox-drain.js";
import { readCurrentSession, writeCurrentSession } from "../current-session.js";

interface ContinueOptions {
  root?: string;
  recent?: boolean;
  all?: boolean;
}

const truncate = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** Trust marker vocabulary — the only labels text output may emit. */
type TrustMarker = "verified" | "accepted" | "rejected" | "pending" | "open";

interface RankedMemoryView {
  readonly id: string;
  readonly kind: string;
  readonly text: string;
  readonly trust: TrustMarker;
  readonly reasons: ReadonlyArray<string>;
  readonly score: number;
}

/**
 * Map the reduced SessionState into a printable continue block. M2.1
 * selection: memories are ranked, deduplicated, then top-N'd per kind.
 */
interface ContinueSummary {
  sessionId: string;
  goal: string;
  status: string;
  lastActivityAt: string | null;
  /** Most recent observation — answers "what was I doing?". */
  doing: { text: string; created_at: string } | null;
  /** Top decisions in rank order. */
  decisions: ReadonlyArray<RankedMemoryView>;
  /** Top conclusions in rank order. */
  conclusions: ReadonlyArray<RankedMemoryView>;
  /** Top hypotheses (filtered to open) with their reasons. */
  hypotheses: ReadonlyArray<RankedMemoryView>;
  /** Top verifications (filtered to open) with their reasons. */
  verifications: ReadonlyArray<RankedMemoryView>;
  suggestedNextStep: { id: string; text: string; source: string } | null;
  /** Counts only — emitted in the trust footer line. */
  trustCounts: Readonly<Record<TrustMarker, number>>;
  /** How many raw memories were ranked before caps. */
  rankedCount: number;
  /** How many duplicates were collapsed. */
  collapsedCount: number;
  /**
   * Legacy M2.0 buckets preserved so existing JSON consumers keep
   * working. Re-derived from the M2.1 deduped set — not separate
   * data. Always present when a M2.0 contract consumer reads it.
   */
  readonly verifiedConclusions?: ReadonlyArray<{ id: string; text: string; marker: TrustMarker }>;
  readonly acceptedDecisions?: ReadonlyArray<{ id: string; text: string; marker: TrustMarker }>;
  readonly rejectedDecisions?: ReadonlyArray<{
    id: string;
    text: string;
    reason: string | null;
    marker: TrustMarker;
  }>;
  readonly proposedDecisions?: ReadonlyArray<{ id: string; text: string; marker: TrustMarker }>;
  readonly openHypotheses?: ReadonlyArray<{ id: string; title: string; marker: TrustMarker }>;
  readonly openVerifications?: ReadonlyArray<{
    id: string;
    command: string;
    state: string;
    marker: TrustMarker;
  }>;
}

const viewOf = (m: RankedMemory): RankedMemoryView => ({
  id: m.id,
  kind: m.kind,
  text: m.text,
  trust: m.trust,
  reasons: m.reasons,
  score: m.score,
});

const summarize = (
  session: SessionRow,
  state: Parameters<typeof rankSessionMemories>[0],
  nowMs: number,
): ContinueSummary => {
  // M2.1: rank → dedup → cap. Same-project memories get a full boost
  // (CROSS_PROJECT_PENALTY = 0). No query (continue has no query).
  const ranked = rankSessionMemories(state, {
    nowMs,
    projectId: session.project_id,
    branchHint: state.current_hypothesis_id,
  });
  const deduped = deduplicateMemories(ranked);
  const collapsed = ranked.length - deduped.length;
  const capped = topNByKind(deduped, DEFAULT_CONTINUE_CAPS);

  const decisions: RankedMemoryView[] = [];
  const conclusions: RankedMemoryView[] = [];
  const hypotheses: RankedMemoryView[] = [];
  const verifications: RankedMemoryView[] = [];

  for (const m of capped) {
    const v = viewOf(m);
    if (m.kind === "decision") decisions.push(v);
    else if (m.kind === "conclusion") conclusions.push(v);
    else if (m.kind === "hypothesis") hypotheses.push(v);
    else verifications.push(v);
  }

  const trustCounts: Record<TrustMarker, number> = {
    verified: 0,
    accepted: 0,
    rejected: 0,
    pending: 0,
    open: 0,
  };
  // Trust counts reflect the full ranked set, not just dedup
  // survivors — otherwise rejected memories vanish from the footer
  // line even though they were ranked.
  for (const m of ranked) trustCounts[m.trust] += 1;

  // Suggested next step: prefer the top open hypothesis, fall back to
  // the top accepted decision.
  let suggested: ContinueSummary["suggestedNextStep"] = null;
  const topHyp = hypotheses[0];
  if (topHyp) {
    suggested = { id: topHyp.id, text: topHyp.text, source: "top-hypothesis" };
  } else {
    const topDec = decisions.find((d) => d.trust === "accepted");
    if (topDec) {
      suggested = { id: topDec.id, text: topDec.text, source: "top-accepted-decision" };
    }
  }

  const doing =
    state.observations.length > 0
      ? {
          text: state.observations[state.observations.length - 1]!.text,
          created_at: state.observations[state.observations.length - 1]!.created_at,
        }
      : null;

  const lastActivityAt =
    state.observations.length > 0
      ? state.observations[state.observations.length - 1]!.created_at
      : session.created_at;

  // Legacy M2.0 buckets — derived from the deduped set so existing
  // JSON consumers keep working without a parallel pipeline.
  const verifiedConclusions = conclusions
    .filter((c) => c.trust === "verified")
    .map((c) => ({ id: c.id, text: c.text, marker: "verified" as TrustMarker }));
  const acceptedDecisions = decisions
    .filter((d) => d.trust === "accepted")
    .map((d) => ({ id: d.id, text: d.text, marker: "accepted" as TrustMarker }));
  const rejectedDecisions = decisions
    .filter((d) => d.trust === "rejected")
    .map((d) => ({
      id: d.id,
      text: d.text,
      reason: state.decisions.get(d.id)?.reason ?? null,
      marker: "rejected" as TrustMarker,
    }));
  const proposedDecisions = decisions
    .filter((d) => d.trust === "pending")
    .map((d) => ({ id: d.id, text: d.text, marker: "pending" as TrustMarker }));
  const openHypotheses = hypotheses
    .filter((h) => h.trust === "open")
    .map((h) => ({ id: h.id, title: h.text, marker: "open" as TrustMarker }));
  const openVerifications = verifications
    .filter((v) => v.trust === "open")
    .map((v) => ({
      id: v.id,
      command: v.text,
      state: "open",
      marker: "open" as TrustMarker,
    }));

  return {
    sessionId: session.id,
    goal: session.goal,
    status: session.status,
    lastActivityAt,
    doing,
    decisions,
    conclusions,
    hypotheses,
    verifications,
    suggestedNextStep: suggested,
    trustCounts,
    rankedCount: ranked.length,
    collapsedCount: collapsed,
    verifiedConclusions,
    acceptedDecisions,
    rejectedDecisions,
    proposedDecisions,
    openHypotheses,
    openVerifications,
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

/** Build the ✓-bullet block for one memory. Always a multi-line block. */
const renderReasons = (reasons: ReadonlyArray<string>, indent: string): string => {
  if (reasons.length === 0) return "";
  // Reasons already end up short; cap to 5 so output stays compact.
  const visible = reasons.slice(0, 5);
  return visible.map((reason) => `${indent}  ✓ ${reason}`).join("\n");
};

/** Short trust tag shown on the [tag] line. */
const trustTag = (t: TrustMarker): string => `[${t}]`;

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

  const empty =
    s.decisions.length === 0 &&
    s.conclusions.length === 0 &&
    s.hypotheses.length === 0 &&
    s.verifications.length === 0;

  if (empty && !s.doing) {
    lines.push("No reasoning recorded yet for this session.");
    lines.push("");
    lines.push("If this project has been active but memory stays empty, the model may");
    lines.push("not be calling Cognit — verify the CLAUDE.md Cognit block / hooks.");
    lines.push("");
    lines.push("Try:");
    lines.push(`  cognit observation "what you're working on"`);
    lines.push(`  cognit decision propose "what you decided"`);
    lines.push(`  cognit verification run "pnpm test"`);
    lines.push("");
    lines.push(`Trust:${renderTrustLine(s.trustCounts)}`);
    return lines.join("\n") + "\n";
  }

  // Verified conclusions come first — proven facts are the highest-
  // value recall payload.
  if (s.conclusions.length > 0) {
    lines.push("Verified:");
    for (const c of s.conclusions) {
      lines.push(`  ${trustTag(c.trust)}  ${truncate(c.text, 70)}`);
      lines.push(renderReasons(c.reasons, "    "));
    }
    lines.push("");
  }

  if (s.decisions.length > 0) {
    lines.push("Decided:");
    for (const d of s.decisions) {
      lines.push(`  ${trustTag(d.trust)}  ${truncate(d.text, 70)}`);
      lines.push(renderReasons(d.reasons, "    "));
    }
    lines.push("");
  }

  if (s.hypotheses.length + s.verifications.length > 0) {
    lines.push("Open:");
    for (const h of s.hypotheses) {
      lines.push(`  [hypothesis] ${truncate(h.text, 65)}`);
      lines.push(renderReasons(h.reasons, "    "));
    }
    for (const v of s.verifications) {
      lines.push(`  [verify]     ${truncate(v.text, 60)}`);
      lines.push(renderReasons(v.reasons, "    "));
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

  if (s.collapsedCount > 0) {
    const noun = s.collapsedCount === 1 ? "duplicate" : "duplicates";
    lines.push(`Selected: ${s.rankedCount} ranked, ${s.collapsedCount} ${noun} collapsed.`);
  } else if (s.rankedCount > 0) {
    lines.push(`Selected: ${s.rankedCount} ranked memories.`);
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
    "If memory stays empty after real work, verify the CLAUDE.md Cognit block",
    "and that hooks are installed (`cognit doctor`).",
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
    .option("--all", "show the full history, not just the last 24h (default: last 24h only)")
    .action(async (opts: ContinueOptions) => {
      const root = opts.root ?? requireProjectRoot();

      // §1: drain the inbox first so the answer reflects just-written
      // files. Best-effort; never blocks the read on a drain failure.
      await drainInboxOnce(root);

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
              const list = yield* sessions.list({ projectId: project.id });
              const candidates = list
                .filter((s) => s.status !== "closed")
                .sort((a, b) => b.created_at.localeCompare(a.created_at));
              target = candidates[0] ?? null;
            }
            if (!target) {
              const list = yield* sessions.list({ projectId: project.id });
              const sorted = [...list].sort((a, b) => b.created_at.localeCompare(a.created_at));
              target = sorted[0] ?? null;
            }
            if (!target) return null;

            const show = yield* sessions.show(target.id);
            writeCurrentSession(root, show.session.id);
            return { row: show.session, state: show.state, projectId: project.id };
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
        state: Parameters<typeof rankSessionMemories>[0];
        projectId: string;
      };
      const summary = summarize(row, state, Date.now());
      void opts.all;
      if (getOutputMode() === "json") {
        emit("json", "continue", summary);
        return;
      }
      process.stdout.write(renderText(summary));
    });
}
