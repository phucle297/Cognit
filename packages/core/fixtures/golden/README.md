# Golden replay fixtures (D-M1-00)

Frozen event logs → pure `reduce` → expected entity-level `SessionState`.

## Layout

Each fixture directory:

| File | Purpose |
|------|---------|
| `meta.json` | `fixture_format`, human `intent`, event count |
| `events.jsonl` | One `ReducerEvent` JSON per line (fixed ULIDs + timestamps) |
| `expected-state.json` | Canonical entity state (Maps as objects; **timeline stripped**) |

## Compare policy

- Timeline is **stripped** before compare (aligns with slim snapshots, D-M1-02).
- Assert entity maps, lifecycle pointers, observations/findings, edges, status, goal, `last_event_*`.

## When to regenerate

Only after an **intentional** reducer / SessionState shape change:

1. Update events if the lifecycle path changes.
2. Re-run the generator or copy actual reduce output into `expected-state.json`.
3. Document the reason in the PR — never regenerate just to “make CI green”.

## Adding a fixture

1. Create `fixtures/golden/<name>/` with fixed-id events.
2. Reduce offline; write entity-stripped expected state.
3. Ensure `meta.json` has `fixture_format: 1` and a clear `intent`.

## CI

`packages/core/test/golden-replay.test.ts` runs under `pnpm --filter @cognit/core test`.
Any PR touching `reducer.ts`, `state.ts`, or `event-types.ts` must keep goldens green.
