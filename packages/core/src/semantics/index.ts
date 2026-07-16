/**
 * Semantic pipeline (D-M5-00): normalize → classify → soft-refine → produce.
 * Pure. Tool is evidence; event type is meaning.
 */
export { ACTION_KINDS, isActionKind, type ActionKind } from "./action-kinds.js";
export { classifyToolSignal } from "./classify.js";
export { normalizeToolSignal, type NormalizeRawInput } from "./normalize.js";
export {
  produceDomainEvent,
  produceFromClasses,
  EVIDENCE_SUMMARY_MAX,
  LARGE_CONTENT_THRESHOLD,
  type ProduceOptions,
} from "./produce.js";
export {
  softRefineClasses,
  refineActionKind,
  evidenceBlob,
  DEFAULT_SOFT_CONFIDENCE_THRESHOLD,
  type SoftClassifier,
  type SoftRefineOptions,
} from "./soft-refine.js";
export type {
  ClassifierInput,
  NormalizedToolSignal,
  ProducedEvent,
  SemanticClass,
  SessionContext,
} from "./types.js";

import { classifyToolSignal } from "./classify.js";
import { normalizeToolSignal, type NormalizeRawInput } from "./normalize.js";
import { produceFromClasses } from "./produce.js";
import { softRefineClasses, type SoftRefineOptions } from "./soft-refine.js";
import type { ProducedEvent, SessionContext } from "./types.js";

export interface SemanticPipelineOptions extends SoftRefineOptions {
  /** When false, skip soft refine (tests / debug). Default true. */
  readonly softRefine?: boolean;
}

/**
 * End-to-end pure pipeline: raw tool fields → domain events.
 * Phase 4: soft-refine upgrades low-confidence action_kind from evidence.
 */
export const semanticPipeline = (
  raw: NormalizeRawInput,
  sessionContext?: SessionContext,
  options: SemanticPipelineOptions = {},
): ReadonlyArray<ProducedEvent> => {
  const signal = normalizeToolSignal(raw);
  let classes = classifyToolSignal({
    signal,
    ...(sessionContext !== undefined ? { sessionContext } : {}),
  });
  if (options.softRefine !== false) {
    classes = softRefineClasses(classes, signal, sessionContext, {
      ...(options.threshold !== undefined ? { threshold: options.threshold } : {}),
      ...(options.softClassifier !== undefined
        ? { softClassifier: options.softClassifier }
        : {}),
    });
  }
  return produceFromClasses(classes, {
    signal,
    linked_hypothesis_id: sessionContext?.current_hypothesis_id ?? null,
  });
};
