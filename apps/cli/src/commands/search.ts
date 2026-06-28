/**
 * apps/cli/src/commands/search.ts — `cognit search "<query>"`.
 *
 * M2.0 recall quality. Reads SQLite DIRECTLY (no Hono server). Returns:
 *
 *   - matching sessions (goal overlap)
 *   - per-session evidence (observations / decisions / conclusions)
 *     with WHY each matched
 *   - a suggested continue target — the most recent active session
 *     that matched, so the user can `cognit continue <id>` (or just
 *     re-run `cognit continue`) immediately
 *
 * Ranks with simple substring match + recency weight. The server has
 * FTS5 / vector scoring — the CLI is the fast path that always works.
 *
 * Output (text): grouped per session, then per match line. JSON
 * envelope via `--json`.
 */
import { Command } from "commander";
import { Effect, Exit, Cause } from "effect";
import { ProjectService, SessionService } from "@cognit/db";
import { findProjectRoot, projectPaths } from "../paths.js";
import { readConfig } from "../yaml-io.js";
import { withAppLayer } from "../layer-build.js";
import { getOutputMode, emit } from "../output.js";
import { requireProjectRoot } from "../auto-session.js";

/** Human label for a field that matched. Stable, no event names. */
type FieldKind = "goal" | "observation" | "decision" | "conclusion";

interface MatchRow {
  readonly kind: FieldKind;
  /** Why this row matched — short, single-line, never raw payload. */
  readonly reason: string;
  /** Short snippet of the matching text. */
  readonly snippet: string;
  readonly score: number;
  readonly created_at: string;
}

interface SessionMatches {
  readonly session_id: string;
  readonly goal: string;
  readonly status: string;
  readonly created_at: string;
  /** Best score across all rows in this session. */
  readonly score: number;
  /** True if the session is non-closed (eligible as continue target). */
  readonly is_open: boolean;
  readonly matches: ReadonlyArray<MatchRow>;
}

interface SearchResponse {
  readonly q: string;
  readonly count: number;
  readonly results: ReadonlyArray<SessionMatches>;
  /**
   * Best continue target — most recent open session in the result set,
   * or `null` when nothing matched or all matches are on closed
   * sessions. The user can pipe this into `cognit continue <id>`.
   */
  readonly continue_target: string | null;
}

interface SearchOptions {
  root?: string;
  limit?: string;
  status?: string;
}

const escapeLike = (q: string): string =>
  q.replace(/[\\%_]/g, (c) => `\\${c}`);

const scoreMatch = (query: string, target: string): number => {
  if (!target) return 0;
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  if (t === q) return 1.0;
  if (t.includes(q)) {
    // Shorter targets score higher (more specific).
    return 0.6 + 0.3 * (q.length / t.length);
  }
  // Token overlap: how many query tokens appear in target.
  const qTokens = q.split(/\s+/).filter((s) => s.length > 0);
  if (qTokens.length === 0) return 0;
  const hits = qTokens.filter((tok) => t.includes(tok)).length;
  return hits === qTokens.length ? 0.4 : (hits / qTokens.length) * 0.3;
};

/**
 * Why a match was returned — single short sentence, never an event
 * name. e.g. `goal match`, `decision text match`.
 */
const reasonFor = (kind: FieldKind, score: number): string => {
  if (score >= 1.0) return `${kind} exact match`;
  if (score >= 0.6) return `${kind} match`;
  return `${kind} partial match`;
};

const truncate = (s: string, n: number): string =>
  s.length > n ? s.slice(0, n - 1) + "…" : s;

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
    // Cap per-session matches to keep output compact.
    const visible = s.matches.slice(0, 5);
    for (const m of visible) {
      lines.push(`     ${m.reason.padEnd(24)}  ${truncate(m.snippet, 60)}`);
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

            const sessionMatches: SessionMatches[] = [];

            for (const s of rows) {
              const matches: MatchRow[] = [];
              const isOpen = s.status !== "closed";

              // Goal match — session-level signal.
              const goalScore = scoreMatch(query, s.goal);
              if (goalScore > 0) {
                matches.push({
                  kind: "goal",
                  reason: reasonFor("goal", goalScore),
                  snippet: s.goal,
                  score: goalScore,
                  created_at: s.created_at,
                });
              }

              // Fold events once per session — cheaper than a per-row query.
              let state: Awaited<ReturnType<typeof sessions.show>>["state"] | null = null;
              try {
                const show = yield* sessions.show(s.id);
                state = show.state;
              } catch (_e) {
                continue;
              }

              for (const o of state.observations) {
                const t = (o as unknown as { text?: string }).text ?? "";
                const sc = scoreMatch(query, t);
                if (sc > 0) {
                  matches.push({
                    kind: "observation",
                    reason: reasonFor("observation", sc),
                    snippet: t,
                    score: sc,
                    created_at: (o as unknown as { created_at: string }).created_at,
                  });
                }
              }

              for (const d of state.decisions.values()) {
                const sc = scoreMatch(query, d.text) * 0.9;
                if (sc > 0) {
                  matches.push({
                    kind: "decision",
                    reason: reasonFor("decision", sc),
                    snippet: d.text,
                    score: sc,
                    created_at: s.created_at,
                  });
                }
              }

              for (const c of state.conclusions.values()) {
                const sc = scoreMatch(query, c.text) * 0.85;
                if (sc > 0) {
                  matches.push({
                    kind: "conclusion",
                    reason: reasonFor("conclusion", sc),
                    snippet: c.text,
                    score: sc,
                    created_at: s.created_at,
                  });
                }
              }

              if (matches.length === 0) continue;

              // Best score drives session ordering.
              const best = matches.reduce((acc, m) => (m.score > acc ? m.score : acc), 0);
              // Within session: score desc, then recency desc.
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

            // Continue target: the most recent open session in the
            // (limited) result set, by created_at desc. If nothing open
            // matched, fall back to the most recent of any open session
            // for the project (so the user can always resume somewhere).
            const open = limited.filter((s) => s.is_open);
            let continueTarget: string | null = null;
            if (open.length > 0) {
              const sorted = [...open].sort((a, b) =>
                b.created_at.localeCompare(a.created_at),
              );
              continueTarget = sorted[0]!.session_id;
            } else if (limited.length > 0) {
              // No open sessions matched — suggest the most recent open
              // session overall (if any), so the user is never stranded.
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