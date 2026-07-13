# 5. Dependency graph

## Visual order

```text
M0 (parallelizable after approval)
├── D-M0-01 CLAUDE.md merge          ── independent
├── D-M0-02 verify endpoint gate     ── independent
├── D-M0-03 root resolution          ── independent (touches many CLI files)
└── D-M0-04 migration packaging      ── independent

M1
├── D-M1-04 redaction wiring         ── independent; prefer early in M1
├── D-M1-03 snapshot schema version  ── before or with D-M1-02
├── D-M1-02 snapshot I/O + timeline  ── AFTER D-M1-03 (serialize format changes)
└── D-M1-01 capture signals          ── independent; can parallel with above

M2
├── D-M2-01 exit codes               ── better AFTER D-M0-03 (shared CLI plumbing)
├── D-M2-03 docs alignment           ── independent; can start anytime after M0
├── D-M2-02 shell completion         ── AFTER D-M0-03 (root flags must work)
└── D-M2-04 npm package              ── AFTER D-M0-04 (bundle correctness)

M3
└── D-M3-01 payload evolution        ── only when needed; no hard dep
```

## Hard blockers

| Task | Blocked by | Why |
|------|------------|-----|
| D-M1-02 snapshot I/O | D-M1-03 (preferred) | Changing serialize format while changing what is stored is riskier as one PR; version first, then slim timeline |
| D-M2-02 completion | D-M0-03 | Completing `--root` before teaching shells bad flags |
| D-M2-04 npm package | D-M0-04 | Publishing broken server/cli packaging multiplies damage |
| D-M2-01 exit codes | D-M0-03 (soft) | Root failures must map to consistent codes |

## Soft / preferred order

1. Land all M0 before any M1 (release train).
2. Within M0: no order required; **prefer D-M0-03 early** if parallel capacity is low (unblocks testing other CLI fixes out-of-tree).
3. Within M1: redaction (safety) → snapshot version → snapshot I/O → capture signals.
4. M2 docs can start in parallel with M1 if staffing allows (no code conflict).

## What does NOT block

- Ontology simplification does not block any milestone.
- FTS does not block.
- Postgres port does not exist as work.
- Dashboard polish does not block CLI production quality.
