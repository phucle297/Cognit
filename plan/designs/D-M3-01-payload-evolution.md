# D-M3-01 — Payload migration evolution (on demand)

## Status (2026-07-13)

**Process ready; no production wire break.**

- Process documented in [`docs/technical/events.md`](../../docs/technical/events.md) (Migration / Payload evolution process).
- Test-local non-identity transforms exercise `migratePayload` via the
  `transformsFor` parameter in `packages/db/test/migrate.test.ts` without
  bumping `CURRENT_VERSION` or registering production `TRANSFORMS`.
- Production `TRANSFORMS` remain identity (`1.0.0 → 1.1.0`, `1.1.0 → 1.2.0`).

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
- (Interim) test-local non-identity suite — **landed**.
