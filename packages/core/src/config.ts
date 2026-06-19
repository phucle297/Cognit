import { Schema } from "effect";

/**
 * Effect Schema definitions for `.cognit/cognit.yaml`. Validated at read
 * time by the CLI and the SDK. Mirrors the sections documented in
 * `plan.xml <config>` and `README.md`.
 *
 * The validation boundary is `Schema.decodeUnknownSync(CognitConfigSchema)`.
 * Bad input throws a `ParseError` with a tree-formatted message.
 *
 * Local-only tool — no auth section. There is no `auth:` block,
 * no `api_token`, no cookie config. The server binds to loopback
 * by default; docker compose overrides the bind host.
 */

// --- atoms ---------------------------------------------------------------

const Name = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(128));
const TrustScore = Schema.Number.pipe(Schema.greaterThanOrEqualTo(0), Schema.lessThanOrEqualTo(1));
const PositiveInt = Schema.Number.pipe(Schema.int(), Schema.greaterThan(0));
const NonNegativeInt = Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0));
const PatternName = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(64));

// --- sections ------------------------------------------------------------

const ProjectConfig = Schema.Struct({ name: Name });
type ProjectConfig = Schema.Schema.Type<typeof ProjectConfig>;

const RedactionPattern = Schema.Struct({
  name: PatternName,
  regex: Schema.String.pipe(Schema.minLength(1)),
  replacement: Schema.String.pipe(Schema.minLength(1)),
});
type RedactionPattern = Schema.Schema.Type<typeof RedactionPattern>;

const RedactionConfig = Schema.Struct({
  enabled: Schema.optionalWith(Schema.Boolean, { default: () => true }),
  patterns: Schema.optionalWith(Schema.Array(RedactionPattern), { default: () => [] }),
});
type RedactionConfig = Schema.Schema.Type<typeof RedactionConfig>;

const UnreferencedAction = Schema.Literal("archive", "delete", "keep");
type UnreferencedAction = Schema.Schema.Type<typeof UnreferencedAction>;

const CleanupConfig = Schema.Struct({
  artifact_max_age_days: Schema.optionalWith(PositiveInt, { default: () => 30 }),
  unreferenced_action: Schema.optionalWith(UnreferencedAction, {
    default: () => "archive" as const,
  }),
  max_db_size_mb: Schema.optionalWith(PositiveInt, { default: () => 1024 }),
});
type CleanupConfig = Schema.Schema.Type<typeof CleanupConfig>;

const SessionConfig = Schema.Struct({
  snapshot_every_n_events: Schema.optionalWith(PositiveInt, { default: () => 100 }),
  fork_on_resume: Schema.optionalWith(Schema.Boolean, { default: () => true }),
});
type SessionConfig = Schema.Schema.Type<typeof SessionConfig>;

const ActorDefaults = Schema.Struct({
  human: Schema.optionalWith(TrustScore, { default: () => 0.9 }),
  worker: Schema.optionalWith(TrustScore, { default: () => 0.6 }),
  system: Schema.optionalWith(TrustScore, { default: () => 1.0 }),
});
type ActorDefaults = Schema.Schema.Type<typeof ActorDefaults>;

const ActorKnown = Schema.Struct({
  name: Schema.String.pipe(Schema.minLength(1)),
  trust_score: TrustScore,
});
type ActorKnown = Schema.Schema.Type<typeof ActorKnown>;

const ActorsConfig = Schema.Struct({
  defaults: Schema.optionalWith(ActorDefaults, {
    default: () => ({ human: 0.9, worker: 0.6, system: 1.0 }) as const,
  }),
  known: Schema.optionalWith(Schema.Array(ActorKnown), { default: () => [] }),
});
type ActorsConfig = Schema.Schema.Type<typeof ActorsConfig>;

const InboxConfig = Schema.Struct({
  watch: Schema.optionalWith(Schema.Boolean, { default: () => true }),
  debounce_ms: Schema.optionalWith(NonNegativeInt, { default: () => 200 }),
  atomic_write_required: Schema.optionalWith(Schema.Boolean, { default: () => true }),
});
type InboxConfig = Schema.Schema.Type<typeof InboxConfig>;

// --- gravity (phase 8) ---------------------------------------------------

/**
 * Per-axis weights for the gravity score. Sum is validated to
 * within ±0.001 of 1.0 on parse (see GravityConfig below). Default
 * from plan §Open decisions #3 (resolved 2026-06-19).
 */
const GravityWeights = Schema.Struct({
  evidence: Schema.optionalWith(
    Schema.Number.pipe(Schema.greaterThanOrEqualTo(0), Schema.lessThanOrEqualTo(1)),
    { default: () => 0.3 },
  ),
  reproducibility: Schema.optionalWith(
    Schema.Number.pipe(Schema.greaterThanOrEqualTo(0), Schema.lessThanOrEqualTo(1)),
    { default: () => 0.3 },
  ),
  confidence: Schema.optionalWith(
    Schema.Number.pipe(Schema.greaterThanOrEqualTo(0), Schema.lessThanOrEqualTo(1)),
    { default: () => 0.2 },
  ),
  trust: Schema.optionalWith(
    Schema.Number.pipe(Schema.greaterThanOrEqualTo(0), Schema.lessThanOrEqualTo(1)),
    { default: () => 0.1 },
  ),
  freshness: Schema.optionalWith(
    Schema.Number.pipe(Schema.greaterThanOrEqualTo(0), Schema.lessThanOrEqualTo(1)),
    { default: () => 0.1 },
  ),
});
type GravityWeights = Schema.Schema.Type<typeof GravityWeights>;

/**
 * Tunable parameters for the gravity engine. The shape itself does
 * not enforce the sum-to-1.0 invariant — that is done by the
 * custom validator below (Schema.transformOrFail / refinement), since
 * Effect Schema does not support cross-field numeric checks out of
 * the box. The schema rejects weights whose sum is outside
 * `[1.0 - 0.001, 1.0 + 0.001]`.
 */
const GravityConfigBase = Schema.Struct({
  /**
   * Half-life in days for the freshness decay function
   * `0.5 ** (age_days / half_life)`. Default 14 (plan §Open
   * decisions #4). Must be > 0.
   */
  freshness_half_life_days: Schema.optionalWith(PositiveInt, { default: () => 14 }),
  weights: Schema.optionalWith(GravityWeights, {
    default: () =>
      ({
        evidence: 0.3,
        reproducibility: 0.3,
        confidence: 0.2,
        trust: 0.1,
        freshness: 0.1,
      }) as const,
  }),
});

/**
 * Refined schema: weights must sum to within ±0.001 of 1.0. We
 * wrap the base struct in a refinement that decodes the candidate
 * and re-checks the sum.
 */
const GravityWeightSumTolerance = 0.001;

export const GravityConfig = GravityConfigBase.pipe(
  Schema.filter((cfg) => {
    const sum =
      cfg.weights.evidence +
      cfg.weights.reproducibility +
      cfg.weights.confidence +
      cfg.weights.trust +
      cfg.weights.freshness;
    return Math.abs(sum - 1.0) <= GravityWeightSumTolerance;
  }),
);
type GravityConfig = Schema.Schema.Type<typeof GravityConfig>;

// --- top-level -----------------------------------------------------------

export const CognitConfigSchema = Schema.Struct({
  project: ProjectConfig,
  redaction: Schema.optionalWith(RedactionConfig, {
    default: () => ({ enabled: true, patterns: [] }) as const,
  }),
  cleanup: Schema.optionalWith(CleanupConfig, {
    default: () =>
      ({
        artifact_max_age_days: 30,
        unreferenced_action: "archive" as const,
        max_db_size_mb: 1024,
      }) as const,
  }),
  session: Schema.optionalWith(SessionConfig, {
    default: () => ({ snapshot_every_n_events: 100, fork_on_resume: true }) as const,
  }),
  actors: Schema.optionalWith(ActorsConfig, {
    default: () =>
      ({
        defaults: { human: 0.9, worker: 0.6, system: 1.0 } as const,
        known: [] as readonly ActorKnown[],
      }) as const,
  }),
  inbox: Schema.optionalWith(InboxConfig, {
    default: () => ({ watch: true, debounce_ms: 200, atomic_write_required: true }) as const,
  }),
  gravity: Schema.optionalWith(GravityConfig, {
    default: () =>
      ({
        freshness_half_life_days: 14,
        weights: {
          evidence: 0.3,
          reproducibility: 0.3,
          confidence: 0.2,
          trust: 0.1,
          freshness: 0.1,
        },
      }) as const,
  }),
});

export type CognitConfig = Schema.Schema.Type<typeof CognitConfigSchema>;
export type { RedactionPattern, UnreferencedAction, ActorKnown };

/**
 * Parse and validate unknown input as a Cognit config. Throws on bad input.
 */
export const parseCognitConfig = Schema.decodeUnknownSync(CognitConfigSchema);

/**
 * The default config written by `cognit init` when no file is present.
 * `project.name` is filled in by the caller; the rest are the spec defaults.
 */
export const defaultConfig = (projectName: string): CognitConfig =>
  parseCognitConfig({
    project: { name: projectName },
  });