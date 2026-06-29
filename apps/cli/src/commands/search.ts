/**
 * apps/cli/src/commands/search.ts — `cognit search "<query>"`.
 *
 * M2.0 recall quality + M2.1 ranking. Reads SQLite DIRECTLY (no Hono
 * server). Returns:
 *
 *   - matching sessions (goal overlap)
 *   - per-session evidence (observations / decisions / conclusions)
 *     ranked by the deterministic scorer in @cognit/core/ranking
 *   - a suggested continue target — the most recent active session
 *     that matched, so the user can `cognit continue <id>` (or just
 *     re-run `cognit continue`) immediately
 *
 * Ranking:
 *   - use the deterministic scorer: verified > accepted > pending >
 *     open, with recency + reference + query bonuses
 *   - top-N per kind (top-2 decisions, top-2 conclusions, …)
 *   - per-row "why this matched" reasons so the agent sees the
 *     signal — no raw scores
 *   - sessions ordered by their best ranked evidence, recency tiebreak
 *
 * Output (text): grouped per session, then per match line with
 * its ✓-bullets. JSON envelope via `--json`.
 */
import { Command } from "commander";
import { Effect, Exit, Cause } from "effect";
import { ProjectService, SessionService } from "@cognit/db";
import {
  DEFAULT_SEARCH_CAPS,
  deduplicateMemories,
  rankSessionMemories,
  topNByKind,
  type RankedMemory,
} from "@cognit/core/ranking";
import { projectPaths } from "../paths.js";
import { readConfig } from "../yaml-io.js";
import { withAppLayer } from "../layer-build.js";
import { getOutputMode, emit } from "../output.js";
import { requireProjectRoot } from "../auto-session.js";

interface MatchRow {
  readonly kind: string;
  readonly reason: string;
  readonly snippet: string;
  readonly score: number;
  readonly created_at: string;
  readonly reasons: ReadonlyArray<string>;
}

interface SessionMatches {
  readonly session_id: string;
  readonly goal: string;
  readonly status: string;
  readonly created_at: string;
  readonly score: number;
  readonly is_open: boolean;
  readonly matches: ReadonlyArray<MatchRow>;
}

interface SearchResponse {
  readonly q: string;
  readonly count: number;
  readonly results: ReadonlyArray<SessionMatches>;
  readonly continue_target: string | null;
}

interface SearchOptions {
  root?: string;
  limit?: string;
  status?: string;
}

/**
 * Project a RankedMemory into the per-row shape the CLI emits.
 * `created_at` is derived from the SQL row timestamp (we carry it
 * through on the ranked memory via createdAtMs by re-emitting the
 * caller's pass-through timestamp).
 */
const toMatchRow = (
  m: RankedMemory,
  createdAt: string,
): MatchRow => {
  const primary = m.reasons[0] ?? "match";
  return {
    kind: m.kind,
    reason: primary,
    snippet: m.text,
    score: m.score,
    created_at: createdAt,
    reasons: m.reasons,
  };
};

const renderText = (q: string, response: SearchResponse): string => {
  if (response.results.length === 0) {
    return [
      `(no matches for "${q}")`,
      "",
      "Next:",
      "  Run `cognit continue` to see what's already remembered.",
      "  Or write what you're looking for as an observation:",
      `    cognit observation "what you tried so far"`,
      "",
    ].join("\n");
  }

  const lines: string[] = [];
  lines.push(`Matches for "${q}" (${response.count} session${response.count === 1 ? "" : "s"})`);
  lines.push("");

  for (const s of response.results) {
    const tag = s.is_open ? `[${s.status}]` : `[closed]`;
    lines.push(`  ${tag} ${s.session_id}  ${truncate(s.goal, 60)}`);
    const visible = s.matches.slice(0, 5);
    for (const m of visible) {
      lines.push(`     ${m.kind.padEnd(12)} ${truncate(m.snippet, 60)}`);
      const bullets = m.reasons.slice(0, 3);
      for (const b of bullets) lines.push(`        ✓ ${b}`);
    }
    if (s.matches.length > visible.length) {
      lines.push(`     ... ${s.matches.length - visible.length} more`);
    }
    lines.push("");
  }

  if (response.continue_target) {
    lines.push(`Continue with: ${response.continue_target}`);
    lines.push(`  cognit continue ${response.continue_target}`);
  } else {
    lines.push(`Continue with: (no open sessions matched)`);
    lines.push(`  Run \`cognit continue\` to pick the most recent active session.`);
  }
  return lines.join("\n") + "\n";
};

const truncate = (s: string, n: number): string =>
  s.length > n ? s.slice(0, n - 1) + "…" : s;

export function registerSearch(program: Command): void {
  program
    .command("search <query>")
    .description("fuzzy-search past sessions by goal, observation, decision, or conclusion text")
    .option("--root <path>", "project root (defaults to nearest .cognit/cognit.yaml)")
    .option("--limit <n>", "max sessions to show (default 20)")
    .option(
      "--status <s>",
      "filter to active|paused|closed (default: any)",
    )
    .action(async (query: string, opts: SearchOptions) => {
      const root = opts.root ?? requireProjectRoot();
      const limit = Math.max(1, Math.min(100, Number(opts.limit ?? "20") || 20));
      const status = opts.status;

      if (!query || query.trim().length === 0) {
        process.stderr.write(`cognit: search query cannot be empty\n`);
        process.exitCode = 2;
        return;
      }

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

            const listOpts: { projectId: string; status?: "active" | "paused" | "closed" } = {
              projectId: project.id,
            };
            if (status === "active" || status === "paused" || status === "closed") {
              listOpts.status = status;
            }
            const rows = yield* sessions.list(listOpts);
            if (rows.length === 0) {
              return {
                q: query,
                count: 0,
                results: [],
                continue_target: null,
              } satisfies SearchResponse;
            }

            const nowMs = Date.now();
            const sessionMatches: SessionMatches[] = [];

            for (const s of rows) {
              const isOpen = s.status !== "closed";

              // Rank this session's memories with the deterministic
              // scorer. Same-project boost = full bonus. Query = the
              // search term. Branch hint = the session's current
              // hypothesis (cheap proxy for "this session's branch").
              const showResult = yield* sessions
                .show(s.id)
                .pipe(Effect.catchAll(() => Effect.succeed(null)));
              if (!showResult) continue;
              const ranked = rankSessionMemories(
                showResult.state,
                { nowMs, query, projectId: project.id, branchHint: showResult.state.current_hypothesis_id },
                { includeObservations: true },
              );
              if (ranked.length === 0) continue;
              // Search must filter to memories that actually overlap the
              // query — otherwise a session with old, unrelated memories
              // gets surfaced for any query.
              const matching = ranked.filter((m) =>
                m.reasons.some((r) => r.startsWith("matches")),
              );
              if (matching.length === 0) continue;
              const deduped = deduplicateMemories(matching);
              const capped = topNByKind(deduped, DEFAULT_SEARCH_CAPS);
              if (capped.length === 0) continue;

              // Session-level score = its best memory score.
              const best = capped.reduce((acc, m) => (m.score > acc ? m.score : acc), 0);

              const matches: MatchRow[] = capped.map((m) =>
                toMatchRow(m, s.created_at),
              );
              // Sort within session: score desc, then trust, then recency.
              matches.sort((a, b) => {
                if (b.score !== a.score) return b.score - a.score;
                return b.created_at.localeCompare(a.created_at);
              });

              sessionMatches.push({
                session_id: s.id,
                goal: s.goal,
                status: s.status,
                created_at: s.created_at,
                score: best,
                is_open: isOpen,
                matches,
              });
            }

            // Sessions: best score desc, then recency desc.
            sessionMatches.sort((a, b) => {
              if (b.score !== a.score) return b.score - a.score;
              return b.created_at.localeCompare(a.created_at);
            });

            const limited = sessionMatches.slice(0, limit);

            // Continue target: most recent open session in the
            // result set, with an overall fallback so the user is
            // never stranded.
            const open = limited.filter((s) => s.is_open);
            let continueTarget: string | null = null;
            if (open.length > 0) {
              const sorted = [...open].sort((a, b) =>
                b.created_at.localeCompare(a.created_at),
              );
              continueTarget = sorted[0]!.session_id;
            } else if (limited.length > 0) {
              const allRows = yield* sessions.list({ projectId: project.id });
              const openOverall = allRows
                .filter((r) => r.status !== "closed")
                .sort((a, b) => b.created_at.localeCompare(a.created_at));
              continueTarget = openOverall[0]?.id ?? null;
            }

            return {
              q: query,
              count: limited.length,
              results: limited,
              continue_target: continueTarget,
            } satisfies SearchResponse;
          }),
        ),
      );

      if (Exit.isFailure(exit)) {
        const cause = Cause.failureOption(exit.cause);
        const msg =
          cause._tag === "Some"
            ? ((cause.value as { message?: string }).message ?? String(cause.value))
            : "search failed";
        process.stderr.write(`cognit: ${msg}\n`);
        process.exitCode = 1;
        return;
      }

      const response = exit.value as SearchResponse;
      if (getOutputMode() === "json") {
        emit("json", "search", response);
        return;
      }
      process.stdout.write(renderText(query, response));
    });
}
