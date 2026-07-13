# D-M2-01 — Exit code contract

## Problem

Commands set `process.exitCode` to 1 or 2 inconsistently; missing args often 1 via commander; not documented. Scripts cannot rely on codes.

## Chosen solution

Document and implement:

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Runtime / internal failure |
| 2 | Usage / validation / not a Cognit project / bad args |
| 3+ | Reserved |

Helpers: `failUsage(msg)`, `failRuntime(msg)` in CLI shared module. Migrate commands incrementally (public verbs first).

## Migration strategy

- Soft: document first; fix public verbs; internal later.
- May change codes for some edge cases — note in changelog.

## Tests required

- Table-driven: outside project → 2; success → 0; forced db error → 1.
