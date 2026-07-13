# D-M1-03 — Snapshot schema version

## Problem

`state_json` has no schema version. Rehydrate casts JSON to `SessionState`. Shape drift can yield silent wrong state instead of fallback.

## Current implementation

- `serializeState` / `rehydrateSessionState` in db package.
- Corrupt JSON → log + full replay.

## Alternatives considered

| Option | Pros | Cons |
|--------|------|------|
| A. Ignore; always full replay | Safe | Loses snapshot benefit |
| B. **Version envelope + invalidate** | Standard | Small format change |
| C. Event-source snapshots only (no state) | Pure | Bigger redesign |

## Chosen solution

**B:**

```json
{
  "schema_version": 1,
  "state": { /* SessionState JSON as today */ }
}
```

1. Writer always writes envelope.
2. Reader: if missing version (legacy bare state) → treat as version 0; accept if compatible or full replay.
3. If version > supported → full replay (and optionally delete bad snapshot later).
4. Bump version when Map fields / entity shapes change.

## Migration strategy

- Read path accepts legacy unversioned JSON (v0).
- Write path always versioned.
- No SQL migration required.

## Risk

- Double-encode bugs. Mitigation: unit tests round-trip.

## Rollback strategy

- Reader keeps accepting v0 and v1.

## Tests required

- Round-trip v1.
- Legacy bare state still loads.
- Future v99 → full replay path.
