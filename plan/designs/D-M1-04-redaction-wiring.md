# D-M1-04 — User redaction wiring fix

## Problem

`DbLive` intends to inject `cognit.yaml` redaction patterns via:

```ts
Layer.provide(RedactorLiveWithDefault, redactionConfig)
```

`RedactorLiveWithDefault` already satisfies `RedactionConfig` with empty defaults (R=`never`), so the provide is a no-op. User patterns never apply. Server may not load yaml patterns at all.

## Current implementation

- Built-ins always in redactor.
- `RedactorLive` needs `RedactionConfig`.
- CLI `layer-build` can pass redactionConfig into `DbLive`.

## Alternatives considered

| Option | Pros | Cons |
|--------|------|------|
| A. Document “user patterns unsupported” | Honest | Regresses advertised feature |
| B. **Fix Layer composition** | Correct | Must verify Effect semantics with test |
| C. Bypass Effect; pass patterns into makeRedactor | Simple | Fights architecture |

## Chosen solution

**B:**

```ts
Layer.provide(RedactorLive, redactionConfig)
```

when caller supplies config; use `RedactorLiveWithDefault` only when no user config.

Also:

1. Ensure CLI reads yaml patterns into `RedactionConfig` layer (verify `buildAppLayer`).
2. Server: either load yaml redaction or document server uses built-ins only (prefer load for parity).
3. Optional: add 2–3 high-value built-in patterns (`sk-`, `ghp_`, `github_pat_`) with false-positive tests.

## Migration strategy

- Behavior becomes stricter (more redaction) — desirable.
- No DB migration.

## Risk

- Over-redaction of user content. Mitigation: careful patterns + tests.

## Rollback strategy

- Revert layer change.

## Tests required

- Integration: yaml pattern redacts on append through DbLive.
- Built-in still applies.
- Server path if touched.
