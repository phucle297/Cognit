import { Schema } from 'effect';

/**
 * Effect Schema definitions for `.cognit/cognit.yaml`. Validated at read
 * time by the CLI and the SDK. Mirrors the sections documented in
 * `plan.xml <config>` and `README.md`.
 *
 * The validation boundary is `Schema.decodeUnknownSync(CognitConfigSchema)`.
 * Bad input throws a `ParseError` with a tree-formatted message.
 */

// --- atoms ---------------------------------------------------------------

const Name = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(128));
const TrustScore = Schema.Number.pipe(
  Schema.greaterThanOrEqualTo(0),
  Schema.lessThanOrEqualTo(1),
);
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

const UnreferencedAction = Schema.Literal('archive', 'delete', 'keep');
type UnreferencedAction = Schema.Schema.Type<typeof UnreferencedAction>;

const CleanupConfig = Schema.Struct({
  artifact_max_age_days: Schema.optionalWith(PositiveInt, { default: () => 30 }),
  unreferenced_action: Schema.optionalWith(UnreferencedAction, { default: () => 'archive' as const }),
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

// --- top-level -----------------------------------------------------------

export const CognitConfigSchema = Schema.Struct({
  project: ProjectConfig,
  redaction: Schema.optionalWith(RedactionConfig, {
    default: () => ({ enabled: true, patterns: [] }) as const,
  }),
  cleanup: Schema.optionalWith(CleanupConfig, {
    default: () => ({
      artifact_max_age_days: 30,
      unreferenced_action: 'archive' as const,
      max_db_size_mb: 1024,
    }) as const,
  }),
  session: Schema.optionalWith(SessionConfig, {
    default: () => ({ snapshot_every_n_events: 100, fork_on_resume: true }) as const,
  }),
  actors: Schema.optionalWith(ActorsConfig, {
    default: () => ({
      defaults: { human: 0.9, worker: 0.6, system: 1.0 } as const,
      known: [] as readonly ActorKnown[],
    }) as const,
  }),
  inbox: Schema.optionalWith(InboxConfig, {
    default: () => ({ watch: true, debounce_ms: 200, atomic_write_required: true }) as const,
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
