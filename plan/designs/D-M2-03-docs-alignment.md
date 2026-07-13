# D-M2-03 — README / scope alignment

## Problem

README understates single-user threat model and over-implies multi-machine magic; five concepts vs internal ontology confuses contributors.

## Chosen solution

Docs-only PR:

1. README: explicit “single-user local-first” section; multi-machine = export/import; no team sync.
2. README: public verbs table; point to `--internal` for power ontology.
3. `docs/technical/scope.md`: threat model + non-goals (no multi-tenant, no PG required).
4. Fix install path to prefer `scripts/up.sh` if that is the reliable linker.
5. Do **not** delete internal features in this PR.

## Tests required

- None code; optional link check.
