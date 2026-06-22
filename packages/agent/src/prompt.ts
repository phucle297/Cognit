/**
 * packages/agent/src/prompt.ts — supervisor prompt builder (C2).
 *
 * Pure: SessionState → string. No DB, no clock, no Effect. The
 * golden-prompt test pins the output to a known snapshot so accidental
 * format changes (which would invalidate the LLM's few-shot examples
 * and any fine-tuning we add later) break CI.
 *
 * Output shape: a single string the LLM is asked to complete with
 * JSON matching `AgentDecision`. The header spells out the JSON
 * contract; the body lists the session's current state in
 * deterministic order (sorted by id) so a re-run with the same state
 * produces the same prompt — useful for replay debugging.
 *
 * Capacity guard: we cap the hypothesis list at
 * `cfg.max_prompt_hypotheses` (default 50) so a runaway session
 * cannot blow the context window. Truncation is signaled in the
 * header so the LLM is not silently blind to late entries.
 */

import type { CognitConfig } from "@cognit/core/config";
import type { SessionState } from "@cognit/core/state";
import type { AgentConfig } from "./agent-config.js";

/** Default cap on hypotheses shown to the LLM per tick. */
export const DEFAULT_MAX_PROMPT_HYPOTHESES = 50;

/**
 * Build the supervisor prompt for one tick of a session.
 *
 * `cfg.gravity` is included so the prompt can remind the LLM which
 * rule-based weights apply — the LLM can choose to weight its
 * overrides differently when it disagrees with the rule engine, and
 * knowing the rule weights helps it explain divergences.
 */
export const buildPrompt = (
  state: SessionState,
  cfg: Pick<CognitConfig, "gravity">,
  agent: Pick<AgentConfig, "max_prompt_hypotheses">,
): string => {
  const cap = agent.max_prompt_hypotheses ?? DEFAULT_MAX_PROMPT_HYPOTHESES;
  const all = Array.from(state.hypotheses.values()).sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  const truncated = all.length > cap;
  const shown = truncated ? all.slice(0, cap) : all;

  const lines: string[] = [];
  lines.push("# Cognit supervisor — emit AgentDecision JSON");
  lines.push("");
  lines.push("You are the AI supervisor for a Cognit session.");
  lines.push(
    "Given the session state below, emit ONE AgentDecision JSON object matching the schema in your system prompt.",
  );
  lines.push("Do not wrap the JSON in markdown fences. Do not add commentary outside the JSON.");
  lines.push("");
  lines.push("## Session");
  lines.push(`session_id: ${state.session_id}`);
  lines.push(`project_id: ${state.project_id}`);
  lines.push(`goal: ${state.goal}`);
  lines.push(`status: ${state.status}`);
  lines.push("");
  lines.push("## Gravity weights (rule-based fallback)");
  lines.push(
    `evidence=${cfg.gravity.weights.evidence} reproducibility=${cfg.gravity.weights.reproducibility} confidence=${cfg.gravity.weights.confidence} trust=${cfg.gravity.weights.trust} freshness=${cfg.gravity.weights.freshness}`,
  );
  lines.push(`freshness_half_life_days: ${cfg.gravity.freshness_half_life_days}`);
  lines.push("");
  lines.push("## Findings");
  if (state.findings.length === 0) {
    lines.push("(none)");
  } else {
    for (const f of state.findings) {
      lines.push(`- ${f.id}: ${f.text}`);
    }
  }
  lines.push("");
  lines.push("## Hypotheses (active)");
  if (shown.length === 0) {
    lines.push("(none)");
  } else {
    for (const h of shown) {
      const conf = h.current_confidence === null ? "?" : h.current_confidence.toFixed(2);
      const aiRank =
        h.ai_rank_score === null
          ? ""
          : ` [ai_rank=${h.ai_rank_score.toFixed(2)}]`;
      lines.push(
        `- ${h.id} conf=${conf}${aiRank} title=${JSON.stringify(h.title)} text=${JSON.stringify(h.text)}`,
      );
    }
    if (truncated) {
      lines.push(`…(${all.length - cap} more hypotheses truncated)`);
    }
  }
  lines.push("");
  lines.push("## Verifications (recent)");
  const recent = Array.from(state.verifications.values())
    .sort((a, b) => a.started_at.localeCompare(b.started_at))
    .slice(-10);
  if (recent.length === 0) {
    lines.push("(none)");
  } else {
    for (const v of recent) {
      const link = v.linked_hypothesis_id ? ` linked=${v.linked_hypothesis_id}` : "";
      lines.push(`- ${v.id} state=${v.state} type=${v.type}${link}`);
    }
  }
  lines.push("");
  lines.push("## Conclusions");
  if (state.conclusions.size === 0) {
    lines.push("(none)");
  } else {
    const ordered = Array.from(state.conclusions.values()).sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    );
    for (const c of ordered) {
      lines.push(`- ${c.id} state=${c.state} text=${JSON.stringify(c.text)}`);
    }
  }
  lines.push("");
  lines.push("## Emit");
  lines.push(
    'Return a JSON object: {"schema_version":"1","rationale":"...","actions":[...],"rank_overrides":[...],"stop":false}',
  );
  return lines.join("\n");
};
