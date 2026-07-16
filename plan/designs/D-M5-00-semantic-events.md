# D-M5-00 — Semantic event pipeline (meaning → Cognit events)

**Status:** Implemented (Phases 1–4)  
**Scope:** Derive domain events from work *meaning*; tool is evidence only.  
**Predecessors:** D-M4-00 inbox OOB

## Principle

> Event type = domain meaning. Tool = evidence on the payload.

```
Raw tool signal → Normalizer → Semantic Classifier → Event Producer → SQLite
```

Classifier runs at **`SessionService.ingest`** (library), not in bash hooks.

## Families → Cognit types

| Family | Type(s) |
|--------|---------|
| Observation | `observation_recorded` |
| Action | `action_recorded` (new) + `action_kind` |
| Verification | `verification_*` |
| Decision | `decision_proposed` (+ later accept) |
| Conclusion | `conclusion_proposed` |
| Artifact | `artifact_attached` |
| Hypothesis | `hypothesis_created` (claims only) |
| Ignore | no domain append |

## Transport

Hooks emit `raw_tool_signal` (non-state). CLI verbs bypass classifier.

## Phases

1. Core types + pure `packages/core/src/semantics/*` + tests (this PR)
2. Ingest wiring + hooks emit raw
3. Dashboard family labels
4. Optional LLM soft classifier

## Non-goals (v1)

- Inventing conclusions without evidence
- Bash-side classification
- Rewriting historical rows in place (use reprocess)

## Phase 4 (polish)

- **Soft refine** (`soft-refine.ts`): upgrades low-confidence `action_kind`
  from evidence text (fix/refactor/generate keywords, diff shape).
- **SoftClassifier** pluggable interface for optional LLM (no network in core;
  `inbox.semantic_llm` config reserved for app wiring).
- **Large evidence**: produce truncates file dumps (`truncated: true`, excerpt only).
- **Lifecycle ignore**: empty/unknown Stop-style signals produce no domain events.
