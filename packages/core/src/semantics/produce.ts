/**
 * Event Producer: SemanticClass → domain append inputs (D-M5-00).
 * Tool evidence is attached; type is meaning.
 * Phase 4: large evidence is truncated (no full file dumps in payload).
 */
import type { NormalizedToolSignal, ProducedEvent, SemanticClass } from "./types.js";

/** Soft cap for evidence summary / excerpts (bytes-ish, string length). */
export const EVIDENCE_SUMMARY_MAX = 240;
export const EVIDENCE_EXCERPT_MAX = 800;
/** When tool input content exceeds this, mark evidence.truncated. */
export const LARGE_CONTENT_THRESHOLD = 4_000;

export interface ProduceOptions {
  readonly signal: NormalizedToolSignal;
  readonly linked_hypothesis_id?: string | null;
}

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;

const stderrFromSignal = (signal: NormalizedToolSignal): string => {
  const resp = asRecord(signal.toolResponse);
  if (resp) {
    for (const k of ["stderr", "stderr_excerpt", "error", "message"]) {
      const v = resp[k];
      if (typeof v === "string" && v.length > 0) return v.slice(0, 500);
    }
    // Nested common shapes
    const out = asRecord(resp["output"]);
    if (out && typeof out["stderr"] === "string") return out["stderr"].slice(0, 500);
  }
  return signal.text.slice(0, 500) || "command failed";
};

const contentSize = (signal: NormalizedToolSignal): number => {
  const input = asRecord(signal.toolInput);
  if (!input) return 0;
  let n = 0;
  for (const k of ["content", "new_string", "old_string", "file_text"]) {
    const v = input[k];
    if (typeof v === "string") n += v.length;
  }
  return n;
};

const evidence = (signal: NormalizedToolSignal): Record<string, unknown> => {
  const size = contentSize(signal);
  const truncated = size > LARGE_CONTENT_THRESHOLD;
  const summary = signal.text.slice(0, EVIDENCE_SUMMARY_MAX);
  const base: Record<string, unknown> = {
    tool: signal.rawToolName,
    path: signal.path,
    command: signal.command,
    summary,
  };
  if (truncated) {
    base["truncated"] = true;
    base["content_chars"] = size;
    // Keep a small excerpt of new_string for UI, never full dump.
    const input = asRecord(signal.toolInput);
    const excerptSrc =
      (typeof input?.["new_string"] === "string" && input["new_string"]) ||
      (typeof input?.["content"] === "string" && input["content"]) ||
      "";
    if (excerptSrc) {
      base["excerpt"] = excerptSrc.slice(0, EVIDENCE_EXCERPT_MAX);
    }
  }
  return base;
};

/**
 * Map one semantic class to zero or one domain event.
 * Verification start+outcome are separate classes → separate events.
 */
export const produceDomainEvent = (
  cls: SemanticClass,
  opts: ProduceOptions,
): ProducedEvent | null => {
  const { signal } = opts;
  const hyp = opts.linked_hypothesis_id ?? null;

  switch (cls.family) {
    case "ignore":
      return null;
    case "observation":
      return {
        type: "observation_recorded",
        payload: {
          text: cls.text,
        },
        confidence: cls.confidence,
        ...(hyp ? { linked_hypothesis_id: hyp } : {}),
      };
    case "action":
      return {
        type: "action_recorded",
        payload: {
          text: cls.text,
          action_kind: cls.action_kind,
          evidence: evidence(signal),
        },
        confidence: cls.confidence,
        ...(hyp ? { linked_hypothesis_id: hyp } : {}),
      };
    case "verification": {
      if (cls.phase === "start") {
        return {
          type: "verification_started",
          payload: {
            command: cls.command,
            type: cls.kind,
            linked_hypothesis_id: hyp,
          },
          confidence: cls.confidence,
          linked_hypothesis_id: hyp,
        };
      }
      const exit = cls.exit_code ?? null;
      const failed = signal.ok === false || (exit !== null && exit !== 0);
      if (failed) {
        return {
          type: "verification_failed",
          payload: {
            stderr_excerpt: stderrFromSignal(signal),
            exit_code: exit,
            stdout_excerpt: null,
            duration_ms: null,
            created_artifact_id: null,
          },
          confidence: cls.confidence,
        };
      }
      return {
        type: "verification_passed",
        payload: {
          exit_code: exit ?? 0,
          stdout_excerpt: null,
          duration_ms: null,
          created_artifact_id: null,
        },
        confidence: cls.confidence,
      };
    }
    case "decision":
      return {
        type: "decision_proposed",
        payload: {
          text: cls.text,
          based_on_conclusion_ids: [] as string[],
        },
        confidence: cls.confidence,
      };
    case "conclusion":
      return {
        type: "conclusion_proposed",
        payload: { text: cls.text },
        confidence: cls.confidence,
      };
    case "artifact":
      return {
        type: "artifact_attached",
        payload: {
          artifact_id: "pending",
          role: cls.role,
          path: cls.path,
          evidence: evidence(signal),
        },
        confidence: cls.confidence,
      };
    case "hypothesis":
      return {
        type: "hypothesis_created",
        payload: { title: cls.title, text: cls.text },
        confidence: cls.confidence,
      };
    default:
      return null;
  }
};

/** Classify → produce list (skips ignore / null). */
export const produceFromClasses = (
  classes: ReadonlyArray<SemanticClass>,
  opts: ProduceOptions,
): ReadonlyArray<ProducedEvent> => {
  const out: ProducedEvent[] = [];
  for (const c of classes) {
    const e = produceDomainEvent(c, opts);
    if (e) out.push(e);
  }
  return out;
};
