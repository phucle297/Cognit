# Events

Cognit ingests structured JSON envelopes dropped into the project's
`.cognit/inbox/` directory. The watcher tails the inbox, validates each
file against the payload schema for its declared `version`, and
inserts an event row in the events table.

This document describes the canonical envelope shape and the migration
path from earlier versions.

## Envelope v1.2.0 (current)

v1.2.0 is the unified, FLAT shape. All producers (wrap, Claude Code,
Codex, OpenCode, Gemini CLI) emit the same layout. The actor fields
are top-level, never nested under `actor:`.

```json
{
  "version": "1.2.0",
  "type": "observation_recorded",
  "session_id": "01HXXXXXXXXXXXXXXXXXXXXXXX",
  "actor_name": "claude-code",
  "actor_type": "worker",
  "id": "01JXXXXXXXXXXXXXXXXXXXXXXXX",
  "source": { "tool": "claude-code", "command": "PostToolUse" },
  "payload": { "text": "tool Edit returned", "tool": "Edit" }
}
```

### Top-level fields

| Field         | Type                                | Notes                                            |
|---------------|-------------------------------------|--------------------------------------------------|
| `version`     | `"1.2.0"`                           | Wire schema version.                             |
| `type`        | `WrapEnvelopeType` (see below)      | Event family.                                    |
| `session_id`  | `string`                            | ULID of the session the event belongs to.        |
| `actor_name`  | `string`                            | FLAT. The producer's registered name.            |
| `actor_type`  | `"worker"`                          | FLAT. Always `"worker"` in v1.2.0.               |
| `id`          | `string`                            | ULID of this event (also the inbox file suffix). |
| `payload`     | `Record<string, unknown>`           | Type-specific body.                              |
| `source`      | `{ tool, command }`                 | Optional. Which hook fired.                      |
| `artifactRefs`| `string[]`                          | Optional. Curation ids referenced.               |
| `causationId` | `string`                            | Optional. Event id that caused this one.         |

### Event families (`type`)

The wrap producer emits the four canonical types:

- `observation_recorded`   — a tool call returned.
- `verification_passed`    — a constraint check passed.
- `verification_failed`    — a constraint check failed.
- `verification_errored`   — the verifier itself threw.

Hooks may also emit:

- `hypothesis_created`     — **legacy** pre-tool (being replaced by semantic pipeline).
- `raw_tool_signal`        — D-M5-00 transport: raw host tool capture (not a timeline domain type).
- `action_recorded`        — D-M5-00: engineering work with meaning; tool is evidence only.

### Semantic pipeline (D-M5-00)

Domain event type is derived from **meaning**, not tool name:

`raw_tool_signal → normalize → classify → produce → append`

See `plan/designs/D-M5-00-semantic-events.md` and `packages/core/src/semantics/`.

### Dual store (D-M6-00)

Classify-path ingest also persists the **redacted full wire envelope** in
`raw_events` (raw-first, then domain). Domain `events.correlation_id` links
to `raw_events.id`. Timeline: `GET /api/events/:id` (domain) and
`GET /api/events/:id/raw` (evidence). Design: `plan/designs/D-M6-00-raw-events-store.md`.

Each type has its own payload schema; see
`packages/db/src/event-schema.ts` for the authoritative Effect Schema
definitions.

## Migration

Cognit's payload schema has three registered versions (`1.0.0`,
`1.1.0`, `1.2.0`) keyed in `PAYLOAD_SCHEMAS_BY_VERSION`
(`packages/db/src/event-schema.ts`). The migration runner
(`packages/db/src/migrate.ts`) walks a payload from its row version
to the current target using the registry in `TRANSFORMS`
(`packages/db/src/migrate.ts`).

### Production transforms (current)

**Both registered production transforms are identity at the payload
level.** There is no field rewrite in production `TRANSFORMS` today:

| Step            | Payload transform | Why                                                                                            |
|-----------------|-------------------|------------------------------------------------------------------------------------------------|
| `1.0.0 → 1.1.0` | identity          | v1.1.0 schemas are a strict superset of v1.0.0 (all new fields optional with `null` defaults). |
| `1.1.0 → 1.2.0` | identity          | The new `hypothesis_ranked` type is purely additive; existing payloads are untouched.          |

Do **not** invent a breaking change solely to exercise the runner.
When a real incompatible field change is required, follow the process
below.

The `EnvelopeSchema` is **already FLAT in v1.0.0** — `actor_name` /
`actor_type` are top-level fields, never nested under `actor:`. The
wire field name is `version` (no underscore) from v1.0.0 onward;
`schema_version` appears only in test fixtures and earlier prototypes,
never in the canonical registry.

What the runner does:

1. **Pick** the schema map for the target version (`schemaMapFor`).
2. **Walk** the registered transform path
   (`transformsFor` → `TRANSFORMS`).
3. **Re-validate** the lifted payload against the target version's
   schema (`Schema.decodeUnknownEither`). This is defence-in-depth: a
   payload that ever drifted between versions fails here rather than
   silently downstream.

If you have legacy envelopes with nested `actor:` blocks or a
`schema_version` field (e.g. imported from a pre-1.0 prototype), they
MUST be normalized at ingestion — the watcher rejects them with
`schema_validation_failure` (unknown field) or `invalid_json`
(malformed). There is no "v1.0.0 nested actor" registry entry, and
none is planned; the canonical v1.0.0 envelope has always been the
FLAT shape documented above.

### Payload evolution process (when a real break is required)

When an event payload field must change **incompatibly** (rename,
remove, change type, or otherwise break existing bytes), do **not**
rewrite historical rows up front. Follow this process:

1. **Bump payload version** — advance `CURRENT_VERSION` and register a
   new entry in `PAYLOAD_SCHEMAS_BY_VERSION` (and the envelope
   `version` literal the inbox accepts). Producers start emitting the
   new version only after the consumer path is ready.
2. **Add a non-identity pure `Transform`** in
   `packages/db/src/migrate.ts` `TRANSFORMS` with `from` / `to` set to
   the adjacent versions. `fn` must be pure (no DB, no clock, no I/O)
   so migration stays replay-deterministic and unit-testable. Scope
   with `type` when the rewrite applies to only one event family.
3. **Golden fixtures** — commit old payload bytes → expected new
   payload (and a negative case if useful). At least one non-identity
   fixture must land with the first real field rewrite.
4. **Re-validate with the target schema** — after `fn`,
   `migratePayload` already decodes against the target version's
   schema; ensure the rewritten shape passes that step.
5. **Prefer read-time migrate** — lift payloads when events are read
   (or on the hot path that already calls `migratePayload`). Avoid a
   rewrite-all DB migration unless operational necessity forces it
   (e.g. indexes on payload fields that cannot be derived at read
   time). Stored `version` on older rows stays historical; the runner
   bridges to `CURRENT_VERSION`.

Unit tests may inject ad-hoc non-identity transforms via the
`transformsFor` argument to `migratePayload` without registering them
in production `TRANSFORMS` or bumping `CURRENT_VERSION`. That proves
the runner path without shipping a wire break.

### Failure categories at migration time

| Failure                                  | Sidecar category                | Where                                  |
|------------------------------------------|---------------------------------|----------------------------------------|
| JSON parse error                         | `invalid_json`                  | watcher / `decodeUnknownEither`        |
| Unknown `version` literal (not in envelope schema) | `schema_validation_failure` | watcher envelope-decode step |
| Payload fails v1.2.0 schema after lift   | `schema_validation_failure`     | `migratePayload` re-validation step    |
| `session_id` not in `sessions` table     | `unknown_session_id`            | watcher, before persistence            |
| `actor_name` not in `actors` table       | `actor_not_registered`          | watcher, before persistence            |
| `actor_type` not literal `"worker"`      | `invalid_actor_type`            | watcher, before persistence            |

See [hooks/README.md](../hooks/README.md) for the canonical category list.

## Versioning policy

- `version` is stamped by the producer. Producers MUST refuse to write
  envelopes with unknown versions.
- The watcher dispatches on the producer's `version` to pick the right
  payload schema. Unknown versions are quarantined under
  `.cognit/inbox/_error/` with a `schema_validation_failure` sidecar
  (the envelope schema accepts `1.0.0`, `1.1.0`, and `CURRENT_VERSION`;
  anything else surfaces here).
- Bumping `version` is a wire-protocol change and ships with a
  migration runner entry (see [Payload evolution process](#payload-evolution-process-when-a-real-break-is-required)).
  Additive-only schema changes may still use identity transforms;
  incompatible field changes require a non-identity pure `Transform`
  plus golden fixtures. Prefer read-time migrate over rewrite-all DB.
- Producers MUST stay on the latest version the inbox accepts
  (currently v1.2.0). Production `TRANSFORMS` are identity-only until
  a real incompatible payload change lands.
