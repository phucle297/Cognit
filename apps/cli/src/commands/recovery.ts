/**
 * apps/cli/src/commands/recovery.ts
 *
 * `cognit recovery <session-id>` and `cognit recovery search <query>`
 *
 * Phase 7r.3: a CLI surface for the v0.2 recovery envelope returned
 * by `GET /api/sessions/:id/recovery` (8 fields) and the fuzzy
 * session search returned by `GET /api/sessions/search` (ranked
 * results over goals/findings/hypotheses/decisions/conclusions).
 *
 * Both subcommands talk to the local Hono server, not the local
 * DB — the recovery surface lives in the @cognit/recovery package
 * and the fuzzy index is wired into the search route. The CLI is a
 * thin client: fetch, format, print.
 *
 * Output mode:
 *   - default (text): human-readable section blocks (recovery) or a
 *     fixed-width table (search).
 *   - --json (set globally via `cognit --json recovery ...`): the
 *     full server envelope passes through unchanged so downstream
 *     tooling can `jq` it.
 *
 * Errors: non-2xx server responses throw `ServerHttpError`. The
 * common 404 case for `recovery <id>` is mapped to exit code 1 with
 * a clean stderr message ("session 'X' not found"). Network failures
 * bubble up and the global handler in `index.ts` exits 1.
 */
import { Command } from "commander";
import { resolveServerUrl, serverFetch, ServerHttpError } from "../server-http.js";
import { emit, getOutputMode } from "../output.js";

interface RecoveryOptions {
  serverUrl?: string;
}

/** All 8 v0.2 fields, in the canonical render order. */
const RECOVERY_FIELDS = [
  "related_sessions",
  "verified_conclusions",
  "rejected_hypotheses",
  "accepted_decisions",
  "rejected_decisions",
  "latest_verification",
  "last_known_state",
  "suggested_next_steps",
] as const;

const truncate = (s: string, n: number): string =>
  s.length > n ? s.slice(0, n - 1) + "…" : s;

const renderSummaryLine = (entry: unknown): string => {
  if (entry === null || typeof entry !== "object") return `  - ${String(entry)}`;
  const e = entry as Record<string, unknown>;
  const id = typeof e["id"] === "string" ? (e["id"] as string) : "";
  const text =
    typeof e["text"] === "string"
      ? (e["text"] as string)
      : typeof e["title"] === "string"
        ? (e["title"] as string)
        : "";
  return `  - ${id}${text ? `  ${truncate(text, 80)}` : ""}`;
};

/**
 * Render the v0.2 recovery envelope as text. Pure: no I/O, no
 * process I/O. Exported so the test suite can drive it directly
 * with a fixed envelope.
 */
export const formatRecoveryText = (
  recovery: Record<string, unknown>,
): string => {
  const lines: string[] = [];
  const sid = typeof recovery["session_id"] === "string" ? (recovery["session_id"] as string) : "";
  if (sid) lines.push(`session: ${sid}`);

  // related_sessions
  const related = Array.isArray(recovery["related_sessions"])
    ? (recovery["related_sessions"] as ReadonlyArray<Record<string, unknown>>)
    : [];
  lines.push(`\nrelated_sessions (${related.length}):`);
  for (const r of related.slice(0, 10)) {
    const score = typeof r["score"] === "number" ? (r["score"] as number).toFixed(3) : "-";
    const matched = typeof r["matched_on"] === "string" ? (r["matched_on"] as string) : "";
    lines.push(`  - ${r["id"]}  score=${score}  ${truncate(matched, 60)}`);
  }

  // verified_conclusions
  const verified = Array.isArray(recovery["verified_conclusions"])
    ? (recovery["verified_conclusions"] as ReadonlyArray<unknown>)
    : [];
  lines.push(`\nverified_conclusions (${verified.length}):`);
  for (const v of verified) lines.push(renderSummaryLine(v));

  // rejected_hypotheses
  const rejected = Array.isArray(recovery["rejected_hypotheses"])
    ? (recovery["rejected_hypotheses"] as ReadonlyArray<unknown>)
    : [];
  lines.push(`\nrejected_hypotheses (${rejected.length}):`);
  for (const h of rejected) lines.push(renderSummaryLine(h));

  // accepted_decisions
  const accepted = Array.isArray(recovery["accepted_decisions"])
    ? (recovery["accepted_decisions"] as ReadonlyArray<unknown>)
    : [];
  lines.push(`\naccepted_decisions (${accepted.length}):`);
  for (const d of accepted) lines.push(renderSummaryLine(d));

  // rejected_decisions
  const rejectedDec = Array.isArray(recovery["rejected_decisions"])
    ? (recovery["rejected_decisions"] as ReadonlyArray<unknown>)
    : [];
  lines.push(`\nrejected_decisions (${rejectedDec.length}):`);
  for (const d of rejectedDec) lines.push(renderSummaryLine(d));

  // latest_verification — wire shape is Record<hypothesisId, summary>
  const lvRaw = recovery["latest_verification"];
  const lv =
    lvRaw !== null && typeof lvRaw === "object" && !Array.isArray(lvRaw)
      ? (lvRaw as Record<string, unknown>)
      : {};
  const lvEntries = Object.entries(lv);
  lines.push(`\nlatest_verification (${lvEntries.length}):`);
  for (const [hypId, summary] of lvEntries.slice(0, 10)) {
    const s = (summary ?? {}) as Record<string, unknown>;
    const state = typeof s["state"] === "string" ? (s["state"] as string) : "-";
    const cmd = typeof s["command"] === "string" ? truncate(s["command"] as string, 60) : "";
    lines.push(`  - ${hypId}  ${state}${cmd ? `  ${cmd}` : ""}`);
  }

  // last_known_state — render a 1-line summary (goal + counts)
  const lks = recovery["last_known_state"];
  if (lks !== null && typeof lks === "object" && !Array.isArray(lks)) {
    const s = lks as Record<string, unknown>;
    const goal = typeof s["goal"] === "string" ? (s["goal"] as string) : "";
    const counts: string[] = [];
    for (const key of ["observations", "findings", "hypotheses", "decisions", "conclusions"] as const) {
      const v = s[key];
      if (Array.isArray(v)) counts.push(`${key}=${v.length}`);
      else if (v !== null && typeof v === "object" && v instanceof Map)
        counts.push(`${key}=${(v as Map<unknown, unknown>).size}`);
    }
    lines.push(`\nlast_known_state: ${goal ? truncate(goal, 80) : "(no goal)"}  ${counts.join("  ")}`);
  }

  // suggested_next_steps
  const steps = Array.isArray(recovery["suggested_next_steps"])
    ? (recovery["suggested_next_steps"] as ReadonlyArray<unknown>)
    : [];
  lines.push(`\nsuggested_next_steps (${steps.length}):`);
  for (const step of steps.slice(0, 10)) lines.push(`  - ${JSON.stringify(step)}`);

  return lines.join("\n") + "\n";
};

/**
 * Render a 3-field minimum recovery block (AC-7.13) used by
 * `cognit session resume` after the resume succeeds. Prints
 * counts + first 3 entries of each field under a clear header.
 */
export const formatRecoveryBlock = (recovery: Record<string, unknown>): string => {
  const lines: string[] = [];
  lines.push("=== Recovery Block ===");
  for (const field of ["rejected_hypotheses", "verified_conclusions", "accepted_decisions"] as const) {
    const arr = Array.isArray(recovery[field])
      ? (recovery[field] as ReadonlyArray<unknown>)
      : [];
    lines.push(`${field} (${arr.length}):`);
    for (const entry of arr.slice(0, 3)) lines.push(renderSummaryLine(entry));
  }
  return lines.join("\n") + "\n";
};

/**
 * Render search results as a fixed-width text table.
 */
const formatSearchResultsText = (results: ReadonlyArray<{
  readonly session_id: string;
  readonly kind: string;
  readonly score: number;
  readonly text: string;
}>): string => {
  if (results.length === 0) return "(no matches)\n";
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

/** Strip the v1 envelope and return the data field. */
const unwrap = (envelope: unknown): unknown => {
  if (
    envelope !== null &&
    typeof envelope === "object" &&
    "data" in (envelope as Record<string, unknown>)
  ) {
    return (envelope as { data: unknown }).data;
  }
  return envelope;
};

/**
 * `cognit recovery <session-id>` — fetch + print the v0.2 recovery
 * envelope. Resolves the server URL from --server-url or
 * COGNIT_SERVER_URL (default 127.0.0.1:6971).
 */
const recoveryFor = async (
  sessionId: string,
  opts: RecoveryOptions,
): Promise<Record<string, unknown>> => {
  const base = resolveServerUrl({ serverUrl: opts.serverUrl });
  const env = await serverFetch(base, `/api/sessions/${encodeURIComponent(sessionId)}/recovery`);
  return unwrap(env) as Record<string, unknown>;
};

const searchSessions = async (
  query: string,
  opts: RecoveryOptions & { status?: string },
): Promise<{
  q: string;
  results: ReadonlyArray<{
    readonly session_id: string;
    readonly kind: string;
    readonly score: number;
    readonly text: string;
  }>;
}> => {
  const base = resolveServerUrl({ serverUrl: opts.serverUrl });
  const qs = new URLSearchParams({ q: query });
  if (opts.status) qs.set("status", opts.status);
  const env = await serverFetch(base, `/api/sessions/search?${qs.toString()}`);
  return unwrap(env) as {
    q: string;
    results: ReadonlyArray<{
      readonly session_id: string;
      readonly kind: string;
      readonly score: number;
      readonly text: string;
    }>;
  };
};

export function registerRecovery(program: Command): void {
  const recovery = program
    .command("recovery")
    .description("read v0.2 recovery envelope or fuzzy-search sessions (7r.3)");

  recovery
    .command("search <query>")
    .description("fuzzy search sessions by goal/finding/hypothesis/decision/conclusion")
    .option("--status <s>", "filter to active|paused|closed")
    .option("--server-url <url>", "server base URL (default: $COGNIT_SERVER_URL or http://127.0.0.1:6971)")
    .action(async (query: string, opts: RecoveryOptions & { status?: string }) => {
      const result = await searchSessions(query, opts);
      if (getOutputMode() === "json") {
        emit("json", "recovery.search", result);
        return;
      }
      process.stdout.write(formatSearchResultsText(result.results));
    });

  recovery
    .command("<session-id>")
    .description("print the v0.2 recovery envelope for a session")
    .option("--server-url <url>", "server base URL (default: $COGNIT_SERVER_URL or http://127.0.0.1:6971)")
    .action(async (sessionId: string, opts: RecoveryOptions) => {
      let recovery: Record<string, unknown>;
      try {
        recovery = await recoveryFor(sessionId, opts);
      } catch (e) {
        if (e instanceof ServerHttpError && e.status === 404) {
          process.stderr.write(`cognit: session '${sessionId}' not found\n`);
          process.exitCode = 1;
          return;
        }
        throw e;
      }
      if (getOutputMode() === "json") {
        emit("json", "session.recovery", recovery);
        return;
      }
      process.stdout.write(formatRecoveryText(recovery));
    });
}

// Re-export the field list for tests + introspection.
export const RECOVERY_FIELD_NAMES: ReadonlyArray<string> = RECOVERY_FIELDS;