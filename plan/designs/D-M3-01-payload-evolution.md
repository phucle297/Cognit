# D-M3-01 — Payload migration evolution (on demand)

## Problem

`migratePayload` + identity transforms exist but no real breaking change has exercised the path. Risk is false confidence.

## Chosen solution

**Process, not speculative rewrite:**

When a payload field must change incompatibly:

1. Bump payload version.
2. Add non-identity `Transform` with pure `fn`.
3. Golden fixtures: old payload bytes → new payload.
4. Re-validate with target schema.
5. Prefer read-time migrate; avoid rewrite-all DB unless necessary.
6. Document in `docs/technical/events.md`.

Do **not** invent a breaking change just to prove the runner.

## Tests required

- At least one non-identity transform fixture when first real change lands.
