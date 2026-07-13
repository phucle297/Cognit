# D-M1-02 — Snapshot tail I/O + timeline slim

## Problem

Snapshot+tail fold is designed, but `_show` still `SELECT *` all session events then filters in JS. Snapshots also embed full `timeline` arrays, so snapshot size grows O(n). `takeIfDue` rebuilds by loading all events.

## Current implementation

- `_show` in `session-service.ts`: load all → filter `id > snapshot.event_id` → `reduce(tail, rehydrated)`.
- `takeIfDue`: load all → `build(events)` → write.
- `SessionState.timeline` append-only full history.

## Alternatives considered

| Option | Pros | Cons |
|--------|------|------|
| A. Full CQRS projections | Fast reads | Over-engineering for scope |
| B. **Tail SQL + slim snapshot timeline** | Small, correct | Careful tests |
| C. Do nothing | — | Fails large sessions |

## Chosen solution

**B:**

1. When snapshot exists:  
   `SELECT * FROM events WHERE session_id = ? AND id > ? ORDER BY created_at ASC, id ASC`  
   (document ULID string order ≡ chronological for this product).
2. When writing snapshots: store **empty timeline** (or last K events, K=0 default) in `state_json`; rebuild timeline only if a caller needs it via optional full replay / separate API.
3. Ensure `reduce` + ranking/`continue` do not require full timeline for primary UX (verify ranking uses entity maps, not timeline). If timeline required for a feature, load on demand.
4. `takeIfDue`: prefer snapshot+tail build path instead of full list when prior snapshot exists.
5. Keep full replay path for invalid snapshots.

**Prerequisite:** D-M1-03 version bump so old fat snapshots still load or invalidate cleanly.

## Migration strategy

- Old snapshots: valid until version invalidation rules say otherwise; may still be large.
- New snapshots: slim.
- Equality: full reduce of all events must equal show() state for entity fields (timeline may differ if slimmed — define equality on entity maps + pointers).

## Risk

- Feature that depended on `state.timeline` length breaks. Mitigation: grep usages; add `loadTimeline` if needed.

## Rollback strategy

- Revert; old behavior.

## Tests required

- Fixture with everyN=10, 50 events: show loads ≤ everyN tail (spy or count).
- Entity-level equality full vs snapshot path.
- continue output unchanged for golden session.
