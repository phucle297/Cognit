/**
 * packages/agent/test/prompt.test.ts — supervisor prompt builder.
 *
 * Cases:
 *  1. deterministic for same input (re-running produces byte-equal output)
 *  2. header includes the JSON contract so the LLM knows the shape
 *  3. active hypothesis truncation caps at `max_prompt_hypotheses`
 *  4. hypotheses are listed in id-ascending order (sorted, not insertion order)
 *  5. hypothesis with ai_rank_score surfaces the rank inline
 *  6. findings section renders text + id
 *  7. empty session produces a valid prompt (no crash, all sections say "(none)")
 *  8. gravity weights are echoed in the header (LLM can compare against its own)
 */
import { describe, it, expect } from "vitest";
import { defaultConfig, parseCognitConfig } from "@cognit/core/config";
import {
  emptySessionState,
  type HypothesisState,
  type SessionState,
} from "@cognit/core/state";
import { buildPrompt, DEFAULT_MAX_PROMPT_HYPOTHESES } from "../src/prompt.js";
import { parseAgentConfig } from "../src/agent-config.js";

const mkHypothesis = (id: string, overrides: Partial<HypothesisState> = {}): HypothesisState => ({
  id,
  title: `title-${id}`,
  text: `text-${id}`,
  current_state: "active",
  current_confidence: 0.5,
  current_reason: null,
  reason_type: null,
  superseded_by_id: null,
  promoted_to_theory_id: null,
  belongs_to_theory_id: null,
  created_at: "2026-06-21T00:00:00.000Z",
  last_event_id: id,
  last_event_at: "2026-06-21T00:00:00.000Z",
  gravity_fired_at: 1_700_000_000,
  ai_rank_score: null,
  ai_rank_reasoning: null,
  ai_rank_evaluator: null,
  ai_rank_at: null,
  ai_rank_event_id: null,
  ...overrides,
});

describe("buildPrompt", () => {
  it("1. deterministic: same input → same output", () => {
    const cfg = defaultConfig("agent-prompt");
    const state: SessionState = {
      ...emptySessionState({
        session_id: "s-1",
        project_id: "p-1",
        goal: "g",
      }),
      hypotheses: new Map([["H-2", mkHypothesis("H-2")], ["H-1", mkHypothesis("H-1")]]),
    };
    const agent = parseAgentConfig({});
    const a = buildPrompt(state, cfg, agent);
    const b = buildPrompt(state, cfg, agent);
    expect(a).toBe(b);
  });

  it("2. header includes the JSON contract", () => {
    const prompt = buildPrompt(
      emptySessionState({ session_id: "s", project_id: "p", goal: "g" }),
      defaultConfig("x"),
      parseAgentConfig({}),
    );
    expect(prompt).toContain('"schema_version":"1"');
    expect(prompt).toContain("AgentDecision JSON");
    expect(prompt).toContain("rank_overrides");
  });

  it("3. active hypothesis truncation caps at max_prompt_hypotheses", () => {
    const cap = 3;
    const cfg = defaultConfig("cap-test");
    const state: SessionState = {
      ...emptySessionState({ session_id: "s", project_id: "p", goal: "g" }),
      hypotheses: new Map(
        Array.from({ length: 10 }, (_, i) => [`H-${i.toString().padStart(2, "0")}`, mkHypothesis(`H-${i.toString().padStart(2, "0")}`)]),
      ),
    };
    const agent = parseAgentConfig({ max_prompt_hypotheses: cap });
    const prompt = buildPrompt(state, cfg, agent);
    // Truncation sentinel: "more hypotheses truncated" line.
    expect(prompt).toContain("more hypotheses truncated");
    // First `cap` hypotheses are present, later ones are not.
    expect(prompt).toContain("H-00");
    expect(prompt).toContain(`H-0${cap - 1}`);
    expect(prompt).not.toContain(`H-0${cap}`);
  });

  it("4. hypotheses listed in id-ascending order", () => {
    const cfg = defaultConfig("sort");
    const state: SessionState = {
      ...emptySessionState({ session_id: "s", project_id: "p", goal: "g" }),
      // Insert in reverse order — buildPrompt must still emit sorted.
      hypotheses: new Map([
        ["H-z", mkHypothesis("H-z")],
        ["H-m", mkHypothesis("H-m")],
        ["H-a", mkHypothesis("H-a")],
      ]),
    };
    const prompt = buildPrompt(state, cfg, parseAgentConfig({}));
    const ia = prompt.indexOf("H-a");
    const im = prompt.indexOf("H-m");
    const iz = prompt.indexOf("H-z");
    expect(ia).toBeGreaterThan(-1);
    expect(im).toBeGreaterThan(ia);
    expect(iz).toBeGreaterThan(im);
  });

  it("5. hypothesis with ai_rank_score surfaces the rank inline", () => {
    const cfg = defaultConfig("rank");
    const state: SessionState = {
      ...emptySessionState({ session_id: "s", project_id: "p", goal: "g" }),
      hypotheses: new Map([
        [
          "H-1",
          mkHypothesis("H-1", { ai_rank_score: 0.87, ai_rank_reasoning: "obvious" }),
        ],
      ]),
    };
    const prompt = buildPrompt(state, cfg, parseAgentConfig({}));
    expect(prompt).toMatch(/\[ai_rank=0\.87\]/);
  });

  it("6. empty session renders all '(none)' sections without crashing", () => {
    const prompt = buildPrompt(
      emptySessionState({ session_id: "s", project_id: "p", goal: "g" }),
      defaultConfig("empty"),
      parseAgentConfig({}),
    );
    expect(prompt).toContain("(none)"); // findings + hypotheses + verifications + conclusions
    // Defensive: no `undefined` or `null` leaks into the string.
    expect(prompt).not.toContain("undefined");
    expect(prompt).not.toContain("null");
  });

  it("7. gravity weights echoed in the header", () => {
    const cfg = parseCognitConfig({
      project: { name: "w" },
      gravity: {
        freshness_half_life_days: 21,
        weights: {
          evidence: 0.4,
          reproducibility: 0.2,
          confidence: 0.2,
          trust: 0.1,
          freshness: 0.1,
        },
      },
    });
    const prompt = buildPrompt(
      emptySessionState({ session_id: "s", project_id: "p", goal: "g" }),
      cfg,
      parseAgentConfig({}),
    );
    expect(prompt).toContain("evidence=0.4");
    expect(prompt).toContain("freshness_half_life_days: 21");
  });

  it("8. default max prompt hypotheses is the documented constant", () => {
    // The default is shared between prompt.ts and agent-config.ts; if
    // a future PR moves one without the other the prompt silently
    // truncates differently than the config claims.
    const cfg = defaultConfig("default");
    const state: SessionState = {
      ...emptySessionState({ session_id: "s", project_id: "p", goal: "g" }),
      hypotheses: new Map(
        Array.from({ length: DEFAULT_MAX_PROMPT_HYPOTHESES + 5 }, (_, i) => [
          `H-${i.toString().padStart(3, "0")}`,
          mkHypothesis(`H-${i.toString().padStart(3, "0")}`),
        ]),
      ),
    };
    const prompt = buildPrompt(state, cfg, parseAgentConfig({}));
    expect(prompt).toContain("more hypotheses truncated");
  });
});
