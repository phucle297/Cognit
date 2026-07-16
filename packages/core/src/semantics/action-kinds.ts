/**
 * Action kinds — meaning labels for `action_recorded` (D-M5-00).
 * These are domain concepts, not tool names.
 */
export const ACTION_KINDS = [
  "applied_fix",
  "refactored",
  "generated",
  "configured",
  "documented",
  "dependency_change",
  "other",
] as const;

export type ActionKind = (typeof ACTION_KINDS)[number];

export const isActionKind = (v: string): v is ActionKind =>
  (ACTION_KINDS as readonly string[]).includes(v);
