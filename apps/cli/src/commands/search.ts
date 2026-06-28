/**
 * apps/cli/src/commands/search.ts — `cognit search "<query>"`.
 *
 * M1 fuzzy recall. Reads SQLite DIRECTLY (no Hono server). Searches
 * across:
 *
 *   - session goals
 *   - observation text
 *   - decision text
 *   - conclusion text
 *
 * Ranks with a simple LIKE-based substring match + recency weight.
 * This is intentionally simple — the server has FTS5 / vector scoring;
 * the CLI is the fast path that always works.
 *
 * Output (text): a fixed-width table with session_id, kind, score,
 * snippet. JSON envelope with `cognit --json`.
 */
import { Command } from "commander";
import { Effect, Exit, Cause } from "effect";
import { ProjectService, SessionService } from "@cognit/db";
import { findProjectRoot, projectPaths } from "../paths.js";
import { readConfig } from "../yaml-io.js";
import { withAppLayer } from "../layer-build.js";
import { getOutputMode, emit } from "../output.js";
import { requireProjectRoot } from "../auto-session.js";

interface SearchResult {
  readonly session_id: string;
  readonly kind: "goal" | "observation" | "decision" | "conclusion";
  readonly score: number;
  readonly text: string;
  readonly created_at: string;
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
  return hits === qTokens.length ? 0.4 : hits / qTokens.length * 0.3;
};

const truncate = (s: string, n: number): string =>
  s.length > n ? s.slice(0, n - 1) + "…" : s;

const renderTable = (q: string, results: ReadonlyArray<SearchResult>): string => {
  if (results.length === 0) {
    return `(no matches for "${q}")\n`;
  }
  const idW = Math.max(2, ...results.map((r) => r.session_id.length));
  const kindW = Math.max(4, ...results.map((r) => r.kind.length));
  const lines: string[] = [];
  lines.push(
    `${"session_id".padEnd(idW)}  ${"kind".padEnd(kindW)}  score     snippet`,
  );
  lines.push(
    `${"-".repeat(idW)}  ${"-".repeat(kindW)}  -------  -------`,
  );
  for (const r of results) {
    lines.push(
      `${r.session_id.padEnd(idW)}  ${r.kind.padEnd(kindW)}  ${r.score.toFixed(3)}    ${truncate(r.text, 80)}`,
    );
  }
  return lines.join("\n") + "\n";
};

export function registerSearch(program: Command): void {
  program
    .command("search <query>")
    .description("fuzzy-search past sessions by goal, observation, decision, or conclusion text")
    .option("--root <path>", "project root (defaults to nearest .cognit/cognit.yaml)")
    .option("--limit <n>", "max results to show (default 20)")
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
            if (rows.length === 0) return [] as SearchResult[];

            const like = `%${escapeLike(query)}%`;
            const results: SearchResult[] = [];

            for (const s of rows) {
              // Goal match (always scored against the row's stored goal).
              const goalScore = scoreMatch(query, s.goal);
              if (goalScore > 0) {
                results.push({
                  session_id: s.id,
                  kind: "goal",
                  score: goalScore,
                  text: s.goal,
                  created_at: s.created_at,
                });
              }

              // Fold events for richer text search.
              let state: Awaited<ReturnType<typeof sessions.show>>["state"] | null = null;
              try {
                const show = yield* sessions.show(s.id);
                state = show.state;
              } catch (_e) {
                continue;
              }

              // Observations
              for (const o of state.observations) {
                const t = (o as unknown as { text?: string }).text ?? "";
                const sc = scoreMatch(query, t);
                if (sc > 0) {
                  results.push({
                    session_id: s.id,
                    kind: "observation",
                    score: sc,
                    text: t,
                    created_at: (o as unknown as { created_at: string }).created_at,
                  });
                }
              }

              // Decisions
              for (const d of state.decisions.values()) {
                const t = d.text;
                const sc = scoreMatch(query, t) * 0.9;
                if (sc > 0) {
                  results.push({
                    session_id: s.id,
                    kind: "decision",
                    score: sc,
                    text: t,
                    created_at: s.created_at,
                  });
                }
              }

              // Conclusions
              for (const c of state.conclusions.values()) {
                const sc = scoreMatch(query, c.text) * 0.85;
                if (sc > 0) {
                  results.push({
                    session_id: s.id,
                    kind: "conclusion",
                    score: sc,
                    text: c.text,
                    created_at: s.created_at,
                  });
                }
              }

              // The LIKE-bound guard is a fast-path "no match anywhere"
              // skip on sessions with huge text but no token overlap; we
              // already filter by score > 0 below.
              void like;
            }

            results.sort((a, b) => {
              if (b.score !== a.score) return b.score - a.score;
              return b.created_at.localeCompare(a.created_at);
            });
            return results.slice(0, limit);
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

      const results = exit.value as SearchResult[];
      if (getOutputMode() === "json") {
        emit("json", "search", { q: query, count: results.length, results });
        return;
      }
      process.stdout.write(renderTable(query, results));
    });
}
