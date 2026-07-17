/**
 * Canonical envelope — the single decode + validation surface shared by
 * every envelope-shaped event source (inbox JSON, server `POST /events`,
 * future MCP/SDK). See designs/D-M4-00-inbox-ingestion-oob.md §1.5.
 *
 * Previously the envelope schema, payload-schema lookup, actor decode,
 * and the typed-error → sidecar-category mapping lived inline in
 * `inbox.ts`. They are extracted here so a source implements only
 * "produce an envelope" — decode, validation, and categorisation are
 * owned once.
 */

import { Data, Either, Schema } from "effect";
import { ActorType } from "./actor";
import { CURRENT_VERSION, PAYLOAD_SCHEMAS_BY_VERSION } from "./event-schema";
import type { InboxFailureCategory } from "./inbox-sidecar";
import type { SessionAppendEventInput } from "./session-service";
import {
  ConstraintViolation,
  DbError,
  SessionClosed,
  UnknownEventType,
  UnknownEventVersion,
  UnknownSession,
  ValidationFailure,
} from "./errors";

/**
 * ULID regex (Crockford base32, 26 chars). Used for the envelope
 * `session_id` field and the filename pattern
 * `<session-id>-<ulid>.json`.
 *
 * Unanchored: `Schema.pattern` anchors to the whole string, so explicit
 * `^…$` would be a no-op.
 */
export const ULID_RE = /[0-9A-HJKMNP-TV-Z]{26}/;

/**
 * Inbox file naming convention: `<session-id>-<event-ulid>.json`.
 * Inbox-specific (it describes the FILE, not the envelope contents), so
 * it stays referenced from `inbox.ts` rather than moving into `ingest`.
 */
export const INBOX_FILENAME_RE = new RegExp(
  `^[0-9A-HJKMNP-TV-Z]{26}-[0-9A-HJKMNP-TV-Z]{26}\\.json$`,
);

/**
 * Envelope schema. `version` is a literal union of every version the
 * schema registry knows; unknown versions fail at envelope-decode.
 * CURRENT_VERSION is included so producers emitting the latest envelope
 * (hooks + @cognit/wrap) are always accepted. `payload` is intentionally
 * `Schema.Unknown` — per-payload validation runs against the
 * version+type keyed map below.
 */
export const EnvelopeSchema = Schema.Struct({
  type: Schema.String.pipe(Schema.minLength(1)),
  version: Schema.Literal("1.0.0", "1.1.0", "1.2.0", CURRENT_VERSION),
  session_id: Schema.String.pipe(Schema.pattern(ULID_RE)),
  actor_name: Schema.String.pipe(Schema.minLength(1)),
  actor_type: ActorType,
  payload: Schema.Unknown,
  // When supplied, the envelope id MUST be a ULID — it becomes the
  // events.id PRIMARY KEY; a non-ULID value would silently break
  // downstream consumers (snapshots, SSE, mempalace links).
  id: Schema.optional(Schema.String.pipe(Schema.pattern(ULID_RE))),
  source: Schema.optional(
    Schema.Struct({
      tool: Schema.String,
      command: Schema.String,
      filePath: Schema.optional(Schema.String),
    }),
  ),
  artifactRefs: Schema.optional(Schema.Array(Schema.String)),
  causationId: Schema.optional(Schema.String),
  correlationId: Schema.optional(Schema.String),
  // Bound confidence to [0, 1] at the envelope boundary (defense in
  // depth); out-of-range values used to surface as a generic DbError
  // from the INSERT, miscategorised as `actor_not_registered`.
  confidence: Schema.optional(
    Schema.Number.pipe(Schema.greaterThanOrEqualTo(0), Schema.lessThanOrEqualTo(1)),
  ),
  parentVerificationId: Schema.optional(Schema.String),
  linkedHypothesisId: Schema.optional(Schema.String),
});

export type Envelope = Schema.Schema.Type<typeof EnvelopeSchema>;

/**
 * Cached compiled payload Schemas, keyed by `"<version>:<type>"`. The
 * registry is module-static, so one lookup table is enough — no
 * per-file cost. Populated lazily on first decode.
 */
const payloadSchemaCache = new Map<string, Schema.Schema<any, any, never>>();

export const lookupPayloadSchema = (
  version: string,
  type: string,
): Schema.Schema<any, any, never> | undefined => {
  const key = `${version}:${type}`;
  const cached = payloadSchemaCache.get(key);
  if (cached) return cached;
  const byVersion = PAYLOAD_SCHEMAS_BY_VERSION[version];
  const schema = byVersion?.[type] as Schema.Schema<any, any, never> | undefined;
  if (schema) payloadSchemaCache.set(key, schema);
  return schema;
};

/**
 * Decode a free-form `actor_type` string. Rejects anything that isn't
 * one of the three literal types the DB CHECK constraint allows, with a
 * clean error rather than a SQLite check violation surfacing via append.
 */
export const decodeActorType = (s: string): Either.Either<ActorType, unknown> =>
  Schema.decodeUnknownEither(ActorType)(s);

/**
 * Decode failures surfaced by `ingest` before the typed `SessionError`
 * channel of `appendEvent`. Each maps to exactly one sidecar / HTTP
 * category via `mapIngestError`, preserving the categories the inbox
 * watcher emitted before the extraction (byte-identical reasons).
 */
export class EnvelopeDecodeFailure extends Data.TaggedError("EnvelopeDecodeFailure")<{
  readonly reason: string;
}> {}
export class PayloadDecodeFailure extends Data.TaggedError("PayloadDecodeFailure")<{
  readonly reason: string;
}> {}
export class UnknownPayloadType extends Data.TaggedError("UnknownPayloadType")<{
  readonly version: string;
  readonly type: string;
}> {}
export class InvalidActorType extends Data.TaggedError("InvalidActorType")<{
  readonly reason: string;
}> {}

/** Errors `ingest` can surface: decode failures + the append SessionError set. */
export type IngestError =
  | EnvelopeDecodeFailure
  | PayloadDecodeFailure
  | UnknownPayloadType
  | InvalidActorType
  | DbError
  | SessionClosed
  | UnknownEventType
  | UnknownEventVersion
  | ValidationFailure
  | UnknownSession
  | ConstraintViolation;

/**
 * The fully-decoded envelope, ready to be turned into an append input
 * against a resolved session id.
 */
export interface DecodedEnvelope {
  readonly type: string;
  readonly version: string;
  readonly sessionId: string;
  readonly actorName: string;
  readonly actorType: ActorType;
  readonly payload: unknown;
  readonly id?: string;
  readonly source?: SessionAppendEventInput["source"];
  readonly artifactRefs?: SessionAppendEventInput["artifactRefs"];
  readonly causationId?: string;
  readonly correlationId?: string;
  readonly confidence?: number;
  readonly parentVerificationId?: string;
  readonly linkedHypothesisId?: string;
}

/**
 * Decode steps 2/4/5 from the old inbox `processFile`:
 *   2. Envelope Schema decode        → EnvelopeDecodeFailure
 *   4. Payload Schema decode         → PayloadDecodeFailure / UnknownPayloadType
 *   5. actor_type literal decode     → InvalidActorType
 *
 * Steps 1 (JSON.parse) and 3 (filename ULID pair) stay with the caller
 * — they are file-specific, not envelope-specific. The append typed
 * error (old step 6) is surfaced by `appendEvent` inside `ingest`.
 */
export const decodeEnvelope = (parsed: unknown): Either.Either<DecodedEnvelope, IngestError> => {
  const envelopeResult = Schema.decodeUnknownEither(EnvelopeSchema)(parsed);
  if (Either.isLeft(envelopeResult)) {
    return Either.left(
      new EnvelopeDecodeFailure({ reason: `envelope: ${String(envelopeResult.left)}` }),
    );
  }
  const p = envelopeResult.right;

  const payloadSchema = lookupPayloadSchema(p.version, p.type);
  if (!payloadSchema) {
    return Either.left(new UnknownPayloadType({ version: p.version, type: p.type }));
  }
  const decoded = Schema.decodeUnknownEither(payloadSchema)(p.payload);
  if (Either.isLeft(decoded)) {
    return Either.left(new PayloadDecodeFailure({ reason: `payload: ${String(decoded.left)}` }));
  }

  const actorTypeResult = decodeActorType(p.actor_type);
  if (Either.isLeft(actorTypeResult)) {
    return Either.left(new InvalidActorType({ reason: String(actorTypeResult.left) }));
  }

  const source: SessionAppendEventInput["source"] | undefined = p.source
    ? {
        tool: p.source.tool,
        command: p.source.command,
        ...(p.source.filePath !== undefined ? { filePath: p.source.filePath } : {}),
      }
    : undefined;

  return Either.right({
    type: p.type,
    version: p.version,
    sessionId: p.session_id,
    actorName: p.actor_name,
    actorType: actorTypeResult.right,
    payload: p.payload,
    ...(p.id !== undefined ? { id: p.id } : {}),
    ...(source !== undefined ? { source } : {}),
    ...(p.artifactRefs !== undefined ? { artifactRefs: p.artifactRefs } : {}),
    ...(p.causationId !== undefined ? { causationId: p.causationId } : {}),
    ...(p.correlationId !== undefined ? { correlationId: p.correlationId } : {}),
    ...(p.confidence !== undefined ? { confidence: p.confidence } : {}),
    ...(p.parentVerificationId !== undefined
      ? { parentVerificationId: p.parentVerificationId }
      : {}),
    ...(p.linkedHypothesisId !== undefined ? { linkedHypothesisId: p.linkedHypothesisId } : {}),
  });
};

/**
 * Build a `SessionAppendEventInput` from a decoded envelope, retargeted
 * at a resolved session id. `ingest` resolves the session (envelope id
 * → sticky pointer → minted bootstrap), then calls this.
 */
/**
 * Reconstruct FLAT wire envelope for raw_events storage / re-ingest.
 * Never JSON.stringify(decoded) — DecodedEnvelope is camelCase.
 * Top-level session/actor keys are snake_case; optional link fields
 * stay camelCase as in EnvelopeSchema.
 */
export const toWireEnvelope = (d: DecodedEnvelope): Record<string, unknown> => {
  const wire: Record<string, unknown> = {
    type: d.type,
    version: d.version,
    session_id: d.sessionId,
    actor_name: d.actorName,
    actor_type: d.actorType,
    payload: d.payload,
  };
  if (d.id !== undefined) wire["id"] = d.id;
  if (d.source !== undefined) {
    wire["source"] = {
      tool: d.source.tool,
      command: d.source.command,
      ...(d.source.filePath !== undefined ? { filePath: d.source.filePath } : {}),
    };
  }
  if (d.artifactRefs !== undefined) wire["artifactRefs"] = d.artifactRefs;
  if (d.causationId !== undefined) wire["causationId"] = d.causationId;
  if (d.correlationId !== undefined) wire["correlationId"] = d.correlationId;
  if (d.confidence !== undefined) wire["confidence"] = d.confidence;
  if (d.parentVerificationId !== undefined) {
    wire["parentVerificationId"] = d.parentVerificationId;
  }
  if (d.linkedHypothesisId !== undefined) {
    wire["linkedHypothesisId"] = d.linkedHypothesisId;
  }
  return wire;
};

export const envelopeToAppendInput = (
  e: DecodedEnvelope,
  sessionId: string,
): SessionAppendEventInput => ({
  type: e.type,
  payload: e.payload,
  sessionId,
  actor: { name: e.actorName, type: e.actorType },
  ...(e.id !== undefined ? { id: e.id } : {}),
  ...(e.source !== undefined ? { source: e.source } : {}),
  ...(e.artifactRefs !== undefined ? { artifactRefs: e.artifactRefs } : {}),
  ...(e.causationId !== undefined ? { causationId: e.causationId } : {}),
  ...(e.correlationId !== undefined ? { correlationId: e.correlationId } : {}),
  ...(e.confidence !== undefined ? { confidence: e.confidence } : {}),
  ...(e.parentVerificationId !== undefined ? { parentVerificationId: e.parentVerificationId } : {}),
  ...(e.linkedHypothesisId !== undefined ? { linkedHypothesisId: e.linkedHypothesisId } : {}),
});

/**
 * Map an `IngestError` to a sidecar/HTTP category + human-readable
 * reason. The four spec categories (`invalid_json`, `unknown_session_id`,
 * `schema_validation_failure`, `actor_not_registered`) are covered;
 * `invalid_json` is never produced here (it is a file-level JSON.parse
 * failure owned by the caller). Categories are byte-identical to the
 * pre-extraction inbox mapping so existing `.reason.txt` sidecars and
 * greps keep matching.
 */
export const mapIngestError = (
  e: IngestError,
): { category: InboxFailureCategory; reason: string } => {
  switch (e._tag) {
    case "EnvelopeDecodeFailure":
      return { category: "schema_validation_failure", reason: e.reason };
    case "PayloadDecodeFailure":
      return { category: "schema_validation_failure", reason: e.reason };
    case "UnknownPayloadType":
      return {
        category: "schema_validation_failure",
        reason: `unknown (version, type) pair: ${e.version}/${e.type}`,
      };
    case "InvalidActorType":
      return { category: "invalid_actor_type", reason: e.reason };
    case "UnknownSession":
      return { category: "unknown_session_id", reason: `session not found: ${e.sessionId}` };
    case "SessionClosed":
      return { category: "unknown_session_id", reason: `session closed: ${e.sessionId}` };
    case "ValidationFailure":
      return {
        category: "schema_validation_failure",
        reason: `${e.type}@${e.version}: ${e.issues}`,
      };
    case "UnknownEventType":
      return { category: "schema_validation_failure", reason: `unknown event type: ${e.type}` };
    case "UnknownEventVersion":
      return {
        category: "schema_validation_failure",
        reason: `unknown version ${e.version} for type ${e.type}`,
      };
    case "ConstraintViolation":
      return { category: "actor_not_registered", reason: `rule ${e.ruleId} blocked: ${e.reason}` };
    case "DbError":
      return { category: "internal_db_error", reason: `db: ${e.message}` };
  }
};
