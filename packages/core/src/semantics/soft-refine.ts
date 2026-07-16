/**
 * Soft refine (D-M5-00 Phase 4).
 *
 * Runs after the rule classifier. Upgrades low-confidence classes using
 * deeper evidence (diff text, response body) without inventing new
 * families. Optional SoftClassifier hooks (e.g. LLM) can further
 * refine when confidence stays below the threshold — pure interface,
 * no network in @cognit/core.
 */
import type { ActionKind } from "./action-kinds.js";
import { isActionKind } from "./action-kinds.js";
import type {
  ClassifierInput,
  NormalizedToolSignal,
  SemanticClass,
  SessionContext,
} from "./types.js";

/** Default: refine when confidence is below this. */
export const DEFAULT_SOFT_CONFIDENCE_THRESHOLD = 0.7;

export interface SoftRefineOptions {
  readonly threshold?: number;
  /**
   * Optional external refine (LLM or learned model). Receives the
   * current classes + signal. Return null to keep heuristic result.
   * Must stay pure/sync from core's POV — async LLM adapters wrap this
   * at the app layer before calling semanticPipeline.
   */
  readonly softClassifier?: SoftClassifier;
}

/**
 * External soft classifier. Implementations may call an LLM offline;
 * the core package never does network I/O.
 */
export type SoftClassifier = (
  input: ClassifierInput & { readonly classes: ReadonlyArray<SemanticClass> },
) => ReadonlyArray<SemanticClass> | null;

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;

/** Collect free text from signal for keyword refine. */
export const evidenceBlob = (signal: NormalizedToolSignal): string => {
  const parts: string[] = [signal.text, signal.command ?? "", signal.path ?? ""];
  const resp = asRecord(signal.toolResponse);
  if (resp) {
    for (const k of [
      "tool_output_for_prompt",
      "tool_output_for_prompt_concise",
      "old_string",
      "new_string",
      "stdout",
      "stderr",
    ]) {
      const v = resp[k];
      if (typeof v === "string") parts.push(v.slice(0, 2000));
    }
    const edits = asRecord(resp["EditsApplied"]);
    if (edits) {
      if (typeof edits["old_string"] === "string") parts.push(edits["old_string"].slice(0, 1500));
      if (typeof edits["new_string"] === "string") parts.push(edits["new_string"].slice(0, 1500));
    }
  }
  const input = asRecord(signal.toolInput);
  if (input) {
    if (typeof input["old_string"] === "string") parts.push(input["old_string"].slice(0, 1500));
    if (typeof input["new_string"] === "string") parts.push(input["new_string"].slice(0, 1500));
    if (typeof input["content"] === "string") parts.push(input["content"].slice(0, 500));
  }
  return parts.join("\n").toLowerCase();
};

const FIX_RE =
  /\b(fix|bugfix|hotfix|patch|workaround|regression|null\s*check|guard\s+clause|typo)\b/;
const REFACTOR_RE =
  /\b(refactor|rename|extract|inline|move\s+to|cleanup|restructure|dedup|simplify)\b/;
const GEN_RE = /\b(scaffold|boilerplate|generate|generated|create\s+file|new\s+file)\b/;

const pathBase = (p: string | null): string => {
  if (!p) return "";
  const parts = p.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] ?? p;
};

const actionText = (kind: ActionKind, signal: NormalizedToolSignal): string => {
  const target = signal.path ? pathBase(signal.path) : signal.tool;
  switch (kind) {
    case "applied_fix":
      return `Applied fix in ${target}`;
    case "refactored":
      return `Refactored ${target}`;
    case "generated":
      return `Generated ${target}`;
    case "configured":
      return `Configured ${target}`;
    case "documented":
      return `Documented ${target}`;
    case "dependency_change":
      return `Updated dependencies (${target})`;
    default:
      return `Changed ${target}`;
  }
};

/**
 * Infer a stronger action_kind from evidence text when the rule
 * classifier left `other` (or low confidence).
 */
export const refineActionKind = (
  current: ActionKind,
  signal: NormalizedToolSignal,
  ctx?: SessionContext,
): { kind: ActionKind; confidence: number } | null => {
  // High-confidence path rules already set documented/dep/config — keep.
  if (
    current === "documented" ||
    current === "dependency_change" ||
    current === "configured"
  ) {
    return null;
  }

  const blob = evidenceBlob(signal);
  const goal = (ctx?.goal ?? "").toLowerCase();
  const combined = `${blob}\n${goal}`;

  if (FIX_RE.test(combined) || (/\bfix\b|\bbug\b/.test(goal) && signal.tool === "search_replace")) {
    return { kind: "applied_fix", confidence: 0.82 };
  }
  if (REFACTOR_RE.test(combined)) {
    return { kind: "refactored", confidence: 0.8 };
  }
  if (GEN_RE.test(combined) && signal.tool === "write") {
    return { kind: "generated", confidence: 0.78 };
  }

  // Diff size heuristic: large new_string with tiny old_string → generated-ish
  const input = asRecord(signal.toolInput);
  if (input && signal.tool === "search_replace") {
    const oldS = typeof input["old_string"] === "string" ? input["old_string"] : "";
    const newS = typeof input["new_string"] === "string" ? input["new_string"] : "";
    if (oldS.length > 0 && newS.length > oldS.length * 3 && newS.length > 400) {
      return { kind: "refactored", confidence: 0.72 };
    }
  }

  return null;
};

const refineOne = (
  cls: SemanticClass,
  signal: NormalizedToolSignal,
  ctx: SessionContext | undefined,
  threshold: number,
): SemanticClass => {
  if (cls.family !== "action") return cls;
  if (cls.confidence >= threshold && cls.action_kind !== "other") return cls;

  const refined = refineActionKind(cls.action_kind, signal, ctx);
  if (!refined) return cls;
  if (cls.action_kind !== "other" && refined.confidence <= cls.confidence) return cls;

  return {
    family: "action",
    text: actionText(refined.kind, signal),
    action_kind: refined.kind,
    confidence: Math.max(cls.confidence, refined.confidence),
  };
};

/**
 * Apply heuristic soft refine, then optional SoftClassifier.
 */
export const softRefineClasses = (
  classes: ReadonlyArray<SemanticClass>,
  signal: NormalizedToolSignal,
  sessionContext?: SessionContext,
  options: SoftRefineOptions = {},
): ReadonlyArray<SemanticClass> => {
  const threshold = options.threshold ?? DEFAULT_SOFT_CONFIDENCE_THRESHOLD;
  let next = classes.map((c) => refineOne(c, signal, sessionContext, threshold));

  if (options.softClassifier) {
    const needsSoft = next.some(
      (c) => c.family !== "ignore" && "confidence" in c && c.confidence < threshold,
    );
    if (needsSoft) {
      const override = options.softClassifier({
        signal,
        classes: next,
        ...(sessionContext !== undefined ? { sessionContext } : {}),
      });
      if (override !== null) {
        // Validate action kinds from external classifier
        next = override.map((c) => {
          if (c.family !== "action") return c;
          if (!isActionKind(c.action_kind)) {
            return { ...c, action_kind: "other" as const };
          }
          return c;
        });
      }
    }
  }

  return next;
};
