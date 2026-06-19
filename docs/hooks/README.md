# Cognit Hooks

Any external AI CLI can publish events to Cognit by writing JSON files
into `.cognit/inbox/`. The watcher (`cognit inbox --watch`) validates
each file against the Effect Schema registry, calls
`SessionService.appendEvent`, and moves it to `.cognit/inbox/processed/`.
On failure the file moves to `.cognit/inbox/_error/` with a sidecar
`<name>.reason.txt` whose first line is `"<category>: <reason>"`.

## Atomic-write protocol

A file is **complete** when its name no longer ends in `.tmp` and its
mtime is older than `inbox.debounce_ms` (default 200ms):

1. Write payload to `.cognit/inbox/<session-id>-<ulid>.json.tmp`
2. `fsync` the temp file
3. Rename to `.cognit/inbox/<session-id>-<ulid>.json`

Both IDs are 26-char Crockford ULIDs. Non-matching files are rejected
with category `unknown_session_id`.

## Envelope shape (v1.0.0)

```json
{
  "schema_version": "1.0.0",
  "type": "observation_recorded",
  "session_id": "01HXY...ULID",
  "actor": {"type": "worker", "name": "claude-code"},
  "source": {"tool": "claude-code", "command": "PostToolUse"},
  "confidence": 0.5,
  "payload": {"text": "edited src/foo.ts"}
}
```

`type` must match a key in `PAYLOAD_SCHEMAS_V1`. Sidecar failure
categories: `invalid_json`, `unknown_session_id`,
`schema_validation_failure`, `actor_not_registered`.

## Two ways to publish

- **Atomic JSON file** — see provider pages below.
- **`cognit wrap -- <cmd> [args...]`** — wraps a worker command and
  emits inbox files automatically.

## Provider guides

- [claude-code](./claude-code.md) · [codex](./codex.md) ·
  [opencode](./opencode.md) · [gemini-cli](./gemini-cli.md)
