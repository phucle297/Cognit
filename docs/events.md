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
  "session_id": "01HXXXXXXXXXXXXXXXXXXXXXXXX",
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

- `hypothesis_created`     — emitted pre-tool by Claude Code / Codex / Gemini.

Each type has its own payload schema; see
`packages/db/src/event-schema.ts` for the authoritative Effect Schema
definitions.

## Migration

Cognit's payload schema has three registered versions (`1.0.0`,
`1.1.0`, `1.2.0`) keyed in `PAYLOAD_SCHEMAS_BY_VERSION`
(`packages/db/src/event-schema.ts:356-362`). The migration runner
(`packages/db/src/migrate.ts`) walks a payload from its row version
to the current target using the registry in `TRANSFORMS`
(`packages/db/src/migrate.ts:42-53`).

**Both registered transforms are identity at the payload level.**
There is no field rewrite inside the runner:

| Step           | Payload transform | Why                                                                                          |
|----------------|-------------------|----------------------------------------------------------------------------------------------|
| `1.0.0 → 1.1.0`| identity          | v1.1.0 schemas are a strict superset of v1.0.0 (all new fields optional with `null` defaults). |
| `1.1.0 → 1.2.0`| identity          | The new `hypothesis_ranked` type is purely additive; existing payloads are untouched.        |

The `EnvelopeSchema` (`packages/db/src/event-schema.ts:65-78`) is
**already FLAT in v1.0.0** — `actor_name` / `actor_type` are
top-level fields, never nested under `actor:`. The wire field name
is `version` (no underscore) from v1.0.0 onward; `schema_version`
appears only in test fixtures and earlier prototypes, never in the
canonical registry.

What the runner does do:

1. **Pick** the schema map for the target version
   (`schemaMapFor`, `packages/db/src/migrate.ts:76-77`).
2. **Walk** the registered transform path
   (`transformsFor` → `TRANSFORMS`, `migrate.ts:42-53`).
3. **Re-validate** the lifted payload against the target version's
   schema (`Schema.decodeUnknownEither`, `migrate.ts:127-138`). This
   is defence-in-depth: a payload that ever drifted between versions
   fails here rather than silently downstream.

If you have legacy envelopes with nested `actor:` blocks or a
`schema_version` field (e.g. imported from a pre-1.0 prototype), they
MUST be normalized at ingestion — the watcher rejects them with
`schema_validation_failure` (unknown field) or `invalid_json`
(malformed). There is no "v1.0.0 nested actor" registry entry, and
none is planned; the canonical v1.0.0 envelope has always been the
FLAT shape documented above.

### Failure categories at migration time

| Failure                                  | Sidecar category                | Where                                  |
|------------------------------------------|---------------------------------|----------------------------------------|
| JSON parse error                         | `invalid_json`                  | watcher / `decodeUnknownEither`        |
| Unknown `version` (not in registry)      | `payload_schema_unknown`        | watcher, before `migratePayload`       |
| Payload fails v1.2.0 schema after lift   | `schema_validation_failure`     | `migratePayload` re-validation step    |
| `session_id` not in `sessions` table     | `unknown_session_id`            | watcher, before persistence            |
| `actor_name` not in `actors` table       | `actor_not_registered`          | watcher, before persistence            |
| `actor_type` not literal `"worker"`      | `invalid_actor_type`            | watcher, before persistence            |

See `docs/hooks/README.md` for the canonical category list.

## Versioning policy

- `version` is stamped by the producer. Producers MUST refuse to write
  envelopes with unknown versions.
- The watcher dispatches on the producer's `version` to pick the right
  payload schema. Unknown versions are quarantined under
  `.cognit/inbox/_error/` with a `payload_schema_unknown` sidecar.
- Bumping `version` is a wire-protocol change and ships with a
  migration runner entry. Producers MUST stay on the latest version
  the inbox accepts (currently v1.2.0).