/**
 * Public surface for the recovery engine.
 *
 *   - `buildRecovery(input)` — pure function that maps a SessionState
 *     plus the latest verification map to the v0.2 envelope (8
 *     top-level fields).
 *
 *   - `serialiseLatestVerification(map)` — convert the
 *     `latest_verification` Map to a plain record for JSON wire
 *     output.
 *
 * Phase 7r.1 ships the 8-field shape with two placeholders
 * (`related_sessions`, `suggested_next_steps`); later beads fill
 * them. This package never imports from `@cognit/db` — the route
 * resolves the inputs once and passes them in.
 */

export {
  buildRecovery,
  serialiseLatestVerification,
  type AcceptedDecision,
  type BuildRecoveryInput,
  type LatestVerification,
  type LatestVerifications,
  type RecoveryV02,
  type RejectedDecision,
  type RejectedHypothesis,
  type RelatedSession,
  type VerifiedConclusion,
} from "./recovery.js";
