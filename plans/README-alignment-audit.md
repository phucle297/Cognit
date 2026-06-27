# README-Alignment Audit (Phase 0)

Read-only snapshot of /home/permees/Projects/github.com/phucle297/Cognit/.
Source: Phase 0 audit gate per plans/README-alignment.xml v0.5.

---

## 1. PORTS

| File:Line | Bind |
|---|---|
| apps/server/src/index.ts:4 | 127.0.0.1:6971 |
| apps/server/src/config.ts:29 | fallback 127.0.0.1 |
| apps/dashboard/src/pages/settings.tsx:44 | port 6971 |
| apps/dashboard/src/app/main.tsx:6 | same-origin 6971 |
| README.md:335 | claims 6970 (DRIFT) |

Canonical: **6971**. README drifts.

## 2. CLI COMMANDS — 29 registered in apps/cli/src/index.ts

init, config, session, snapshot, append, inbox, events, observation, finding,
hypothesis, theory, experiment, decision, conclusion, verification, wrap,
artifact, edge, constraint, redaction, schema-dump, server, dashboard, gc,
export, import, recovery, agent, ask.

NOTE: README shows `cognit observation add`. Code registers `observation`
parent + `observe` subcommand (apps/cli/src/commands/observation.ts:131).

## 3. STATE TYPES — 12 (1 ReducerEvent + 11 entity states)

packages/core/src/state.ts exports: ReducerEvent, ObservationState,
FindingState, HypothesisState, TheoryState, ExperimentState, DecisionState,
ConclusionState, VerificationState, ArtifactState, EdgeState, SessionState.

11 entity states (AC3 target): Observation, Finding, Hypothesis, Theory,
Experiment, Decision, Conclusion, Verification, Artifact, Edge, Session.

README lists only 7 cognition concepts — missing Theory, Artifact, Edge, Session.

## 4. TABLES — 11

packages/db/src/schema/tables.ts TABLES_DDL: projects, sessions, actors,
events, snapshots, artifacts, edges, constraint_rules, schema_version,
hypotheses, inbox_processed.

Cognition-related first-class tables (AC4 subset): hypotheses, artifacts,
edges, snapshots.

## 5. ROUTES — 9 (+ catch-all redirect)

apps/dashboard/src/app/router.tsx:50-59:
`/`, `/timeline`, `/knowledge-graph`, `/decision-graph`, `/verification`,
`/ai-reasoning`, `/recovery-center`, `/rules`, `/settings`, `*` (redirect).

README lists only 6 — missing AI Reasoning, Rules, Settings.

## 6. ENVELOPE VERSION + SHAPE DRIFT

| Source | Version | Shape |
|---|---|---|
| packages/wrap/src/index.ts:72 | v1.1.0 | FLAT (actor_name L95, actor_type L96) |
| docs/hooks/README.md:26 | v1.0.0 | NESTED actor:{type,name} |
| docs/hooks/codex.md:30,42 | v1.0.0 | NESTED |
| docs/hooks/claude-code.md:36-37 | v1.0.0 | NESTED |
| docs/hooks/opencode.md:30 | v1.0.0 | NESTED |
| docs/hooks/gemini-cli.md:40 | v1.0.0 | NESTED |
| packages/db/src/event-schema.ts:15 | CURRENT_VERSION v1.2.0 | FLAT (L193-194 actor_type/actor_name) |

Canonical = v1.2.0 FLAT (per event-schema).

## 7. PAYLOAD_SCHEMAS_BY_VERSION

packages/db/src/event-schema.ts:356-362:
```
{
  "1.0.0": PAYLOAD_SCHEMAS_V1,
  "1.1.0": PAYLOAD_SCHEMAS_V1_1_0,
  "1.2.0": PAYLOAD_SCHEMAS_V1_2_0,
}
```

All three keys present.

## 8. MIGRATE FUNCTION LOCATION

| Symbol | File:Line |
|---|---|
| `migratePayload` (Effect runner) | packages/db/src/migrate.ts:87-140 |
| `TRANSFORMS` registry (1.0.0→1.1.0 identity, 1.1.0→1.2.0) | packages/db/src/migrate.ts:42-53 |
| JSDoc reference (NOT code) | packages/db/src/event-schema.ts:5 |

Symbol name: `migratePayload` (NOT `migrate`).

## 9. WRAP FLAT-SHAPE VERIFICATION

packages/wrap/src/index.ts:91-102 (WrapEnvelope interface):
- L95: `readonly actor_name: string;`
- L96: `readonly actor_type: "worker";`

CONFIRMED FLAT — no nested actor object.

## 10. DOCS/ EXISTENCE TABLE

| Path | Status |
|---|---|
| docs/architecture.md | ABSENT |
| docs/data-model.md | ABSENT |
| docs/events.md | ABSENT |
| docs/hooks.md | ABSENT |
| docs/cli.md | ABSENT |
| docs/dashboard.md | ABSENT |
| docs/configuration.md | ABSENT |
| docs/storage.md | ABSENT |

All 8 cited paths ABSENT. Phase F creates 7 (excludes events.md). Phase G creates events.md.

## 11. TSX CHECK

apps/cli/package.json:36: `"tsx": "^4.22.4"` — present.

## 12. SDK CURRENT EXPORTS

packages/sdk/src/index.ts (3 lines):
```
export const PHASE = 0 as const;
```
Placeholder only. Phase G adds typed exports map + re-exports.

## 13. APPS/CLI/SRC/PATHS.TS IMPORTERS — 33 files

Symbols: findProjectRoot, cognitDir, projectPaths, COGNIT_SUBDIRS,
COGNIT_FILES, ProjectPaths, isCognitProject, expandHome.

Importers (apps/cli/src/** — internal):
- apps/cli/src/agent-state.ts:22
- apps/cli/src/current-session.ts:19
- apps/cli/src/layer-build.ts:39
- apps/cli/src/commands/{init,config,session,snapshot,append,inbox,events,observation,finding,hypothesis,theory,experiment,decision,conclusion,verification,wrap,artifact,edge,constraint,redaction,server,gc,export,import,agent,ask}.ts
- apps/cli/test/paths.test.ts:5
- apps/cli/test/sticky-session.test.ts:11

Cross-app:
- apps/server/src/index.ts:62 — the J-drift

Phase G must update apps/server/src/index.ts:62 (Phase H actually) + keep
apps/cli/src/paths.ts as shim re-exporting @cognit/core/paths so 33 importers
keep working.

## 14. README SECTION LINE RANGES (parallel-safety anchors)

| Section | Lines | Header line |
|---|---|---|
| What Cognit Stores | 67-105 | 67 |
| Dashboard | 250-282 | 250 |
| Installation + ports block | 305-337 | 305 |
| Advanced Usage CLI table | 355-385 | 355 |
| Documentation | 387-408 | 387 (changelog inserts BEFORE) |

Parallel writers (Batch 1):
- Phase A owns L305-337 (ports)
- Phase B owns L355-385 (CLI table)
- Phase C owns L67-105 (concepts + storage section insert)
- Phase D owns L250-282 (dashboard)

Disjoint — confirmed.

---

## Cross-cutting drift

1. Port 6971 vs README 6970.
2. CLI command `observe` (not `observation add`).
3. README concepts 7 vs code 11 entity states.
4. README storage underdocumented (no table list).
5. Envelope v1.1.0 wrap vs v1.0.0 docs/hooks (NESTED).
6. SDK placeholder.
7. All 8 docs/ ABSENT.
8. paths.ts coupled to apps/cli + 1 cross-app importer (server).
9. apps/server/package.json:19 `workspace:^` typo.
10. apps/cli/package.json no `dev` script.