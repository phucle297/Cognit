# Plan — Simplify Public Surface (Phase B)

Phase A shipped. Onboarding + install + optional packages frozen.
Goal: hide complexity without losing capability.
Backward compat preserved. No deletions.

---

## 1. Public Concepts — Audit + Disposition

### 1.1 Vocabulary triage table

#### Core nouns (user-facing product surface)

| Term | Where | Disposition |
|---|---|---|
| Project | README, docs | Keep |
| Session | README, docs, dashboard | Keep |
| Observation | timeline, events.md, cli.md | Keep |
| Finding | timeline, cli.md | **Merge into Observation** in user copy (timeline row shows kind chip) |
| Hypothesis | timeline, graph, AI reasoning | Keep |
| Verification | timeline, verification page | Keep — rename sub-status to "Check" |
| Conclusion | timeline, AI reasoning | Keep |
| Decision | decision graph | Keep |
| Artifact | timeline, storage | Keep |
| Constraint Rule | rules page | Keep — surface name = "Guardrail" in user copy |
| Edge | knowledge graph | **Rename → Link** in user copy |
| Hook | install, hooks.md | Keep |
| Inbox | `.cognit/inbox/`, storage | Keep |
| Envelope | events.md, hooks | Keep — only in advanced docs |
| Dashboard | README, all docs | Keep |
| ULID / event id | placeholder examples | Keep as placeholder; hide in UI |
| Reducer / SessionState | data-model.md, architecture.md | **Hide** — drop word, replace with "folding engine" |

#### Hide from happy-path (move to advanced)

| Term | Why |
|---|---|
| Theory / Theory lifecycle | Experimental, gated by `COGNIT_QUIET_DEPRECATIONS` |
| Experiment / Experiment lifecycle | Experimental, gated |
| `theory_*` / `experiment_*` events | Experimental |
| `hypothesis_ranked` event | AI-supervisor internal |
| `ai_rank_*` fields | AI-supervisor internal |
| `gravity.*` config block | Power-user; defaults work |
| `redaction_applied` event | Audit-only |
| `constraint_rule_added/applied` events | Audit-only |
| `project_created`, `actor_registered`, `snapshot_created` | Audit-only |
| `causation_id`, `correlation_id`, `parent_verification_id`, `linked_hypothesis_id` | Dev-only payload fields |
| `current_*` pointers | Implementation detail |
| Schema version table (`schema_version`) | Internal |
| `WRAP_SCHEMA_VERSION`, `EnvelopeSchema`, `TRANSFORMS`, `migratePayload` | Developer-only |
| SQLite pragmas (`WAL`, `busy_timeout`, ...) | Debug-only |
| `session.{snapshot_every_n_events,fork_on_resume}` | Power-user; advanced only |
| `inbox.{debounce_ms,atomic_write_required}` | Power-user |
| `trust_score` | **Rename → weight** in user copy |

### 1.2 Minimal user-facing vocabulary (target set)

**Core nouns (7):** Project, Session, Observation, Hypothesis, Check (= Verification), Conclusion, Decision.

**Plumbing (5):** Hook, Inbox, Envelope, Dashboard, Artifact.

**Guards (1):** Guardrail (= Constraint Rule).

**Lifecycle verbs (user types these):**
- `cognit observe`
- `cognit hypothesis …`
- `cognit check …` (alias for verify)
- `cognit decide …`
- `cognit conclude …`

Every other term stays in code, in storage, in `data-model.md` advanced section — never on a happy-path page.

---

## 2. Public CLI — Tier Classification

### 2.1 Public tier (default in `cognit --help`)

| Command | Purpose |
|---|---|
| `cognit init` | Bootstrap `.cognit/`, install hooks |
| `cognit dashboard` | Start dashboard |
| `cognit doctor` | **NEW** — healthcheck (project, db, hooks, inbox, server) |
| `cognit session ls` | List sessions (alias for `list`) |
| `cognit reset` | **NEW** — wipe `.cognit/` (with confirm) |
| `cognit update` | **NEW** — `pnpm update -g cognit` wrapper |
| `cognit env` | Print shell env (`--shell` for eval) |
| `cognit config --show` | Read `cognit.yaml` |
| `cognit recovery` | Print v0.2 recovery envelope |
| `cognit recovery search` | Fuzzy session search |
| `cognit export` / `cognit import` | tar.gz portability |
| `help`, `version` | Built-in |

### 2.2 Advanced tier (`--internal` flag or `cognit --advanced`)

| Command | Reason |
|---|---|
| `snapshot`, `append`, `events` | Power-user inspection |
| `verify`, `verify cancel/pass/fail/error/rerun` | Manual lifecycle control |
| `wrap`, `wrap -- <cmd>` | Subprocess envelope producer |
| `artifact add`, `edge add/list` | Entity ops |
| `constraint add/list/test` | Guardrail admin |
| `redaction test` | Debug |
| `schema-dump` | Integrator reference |
| `gc` | Maintenance |
| `ask` | LLM one-shot |
| `server` | Runtime lifecycle |
| `theory`, `experiment` | Experimental (kept, still gated) |

### 2.3 Internal / AI-only tier (`--internal` flag, documented separately as "AI hooks")

| Command | Reason |
|---|---|
| `session ensure`, `session create`, `session show`, `session resume`, `session pause`, `session close` | AI/hook territory |
| `observe`, `finding`, `hypothesis …`, `decision …`, `conclusion …` | AI-primary writers |
| `agent run`, `agent status`, `agent stop` | AI supervisor loop |
| `inbox --watch`, `inbox --process` | Inbox processor |
| `config --edit` | Operator only |

### 2.4 Implementation

- All commands stay registered. `visibility.ts` already gates via `--internal`.
- Promote `env`, `recovery`, `export`, `import`, `config --show` to public set in `visibility.ts`.
- Add `doctor`, `reset`, `update` as new public commands (additive, no deletion).
- Aliases: `cognit check` = `cognit verify`; `cognit decide` = `cognit decision`; `cognit conclude` = `cognit conclusion` (pure wrappers).

---

## 3. Dashboard — Simplification Proposal

### 3.1 Current state (9 routes)

Public sidebar (4): `/`, `/timeline`, `/knowledge-graph`, `/settings`.
Deep-link hidden (5): `/decision-graph`, `/verification`, `/ai-reasoning`, `/recovery-center`, `/rules`.

### 3.2 Target state

#### Public pages (4, unchanged URLs)

| Route | Page | Purpose |
|---|---|---|
| `/` | Overview | Project header, New Session, sessions list, "Recent reasoning" feed |
| `/timeline` | Timeline | Per-session live SSE stream. Filters: kind, actor, date |
| `/knowledge-graph` | Graph | xyflow canvas: nodes for hypotheses, conclusions, decisions, links |
| `/settings` | Settings | Server, Project (read-only), Display |

#### New "Advanced" disclosure inside Settings (1 new section, 0 new routes)

Collapsible card inside `/settings` titled **Advanced** with:
- **Guardrails** (was `/rules`) — constraint CRUD
- **Recovery** (was `/recovery-center`) — session picker + 8 ops
- **Decisions** (was `/decision-graph`) — decision-only canvas
- **Checks** (was `/verification`) — verification table
- **AI reasoning** (was `/ai-reasoning`) — hypothesis ranking

URLs preserved as deep-links from Overview/Timeline row actions. Inside the Advanced card they render as `<Dialog>` or `<Sheet>` overlays, not full pages. This:
- collapses 5 routes into 1 collapsible section
- keeps backward compat (old URLs still resolve)
- eliminates 5 lazy chunks

#### Recovery UX change (P0)

Add a row action on Timeline/Graph: **"Why was this rejected?"**
Opens a 1-pane dialog:
- Hypothesis: `auth middleware reads token from Authorization header`
- Status: rejected
- Top 3 supporting observations (links)
- Top 1 contradicting observation (link)
- Linked verification result (link)
- AI rank history sparkline
- "Resume this investigation" button

This collapses the recovery story into 1 click instead of navigating to `/recovery-center` and picking a session.

#### Other dashboard touchpoints

- StatCards on Overview: rename to **Sessions / This week / Open decisions**.
- Remove `edge_created` event display from Timeline; render only as Link rows on Graph.
- Hide event id (`01HXXX…`) by default; show under "Copy id" disclosure.
- Hide schema version / envelope version / reducer state from any page header.
- Decision Graph node types: render inside Graph with kind filter chip; no separate page.

### 3.3 Page merges detail

| From route | To | Mechanism |
|---|---|---|
| `/rules` | `/settings` → Advanced → Guardrails | Dialog |
| `/recovery-center` | `/settings` → Advanced → Recovery | Dialog |
| `/decision-graph` | `/knowledge-graph` | `?kind=decision` query filter |
| `/verification` | `/timeline` | `?kind=verification_*` filter chip |
| `/ai-reasoning` | `/knowledge-graph` | `?ai=1` query mode |

All source files stay. Renderer routes through wrapper component that decides panel vs page.

---

## 4. Public Data Model — Hide Surface

### 4.1 Things to hide from any UI label

- Event ids (`01HXXX…`) — display only when user clicks "Copy id".
- ULID placeholder in user examples — replace with short hash or friendly ref.
- Schema version (`v1.0.0`, `v1.1.0`, `v1.2.0`) — hide from event detail sheet.
- Edge types (`supports`, `contradicts`, `supersedes`, ...) — render as `Link: hypothesis A → hypothesis B`; show type only on hover.
- Constraint rule ids — show as `Rule #1` ordinal.
- Internal reducer state name (`SessionState`) — drop from data-model.md prose.

### 4.2 What surfaces instead

- Friendly ref: `Hypothesis #h3` instead of `01HXXXXXXXXXXXXXXXXXXXXX`.
- Time-relative: "2 min ago" instead of `2026-06-28T13:42:01.234Z`.
- Status chip: `active` / `weakened` / `rejected` / `promoted` (already done).
- Confidence as 1-5 dots (already done).
- "Linked to" section with hypothesis/verification/conclusion names.

### 4.3 Storage unchanged

All event ids, schema versions, edge types, rule ids remain in DB.
Just stop showing them in default UI.

---

## 5. Recovery UX — 30-Second Rule

### 5.1 Current pain

User journey to answer "why did AI reject this?":
1. Open dashboard
2. Click session
3. Open Timeline
4. Filter by hypothesis_rejected
5. Click hypothesis row
6. Sheet opens, shows payload, no explanation
7. Click "Related" — opens Graph
8. Navigate to Recovery Center
9. Pick session again
10. Find `rejected_hypotheses` section
11. Scan table

→ 10+ steps. Fails 30-second test.

### 5.2 Target

1. Open dashboard
2. Click session with rejected hypothesis
3. Timeline row shows rejected hypothesis chip → click
4. Sheet: top section "Why rejected" with 3 bullets + linked observations
5. Optional: "See full reasoning" → Graph

→ 4 steps. Hits 30-second test.

### 5.3 Implementation

Add `rejection_summary` derived field on Hypothesis state (computed in reducer, not stored):
```ts
{
  contradicting: ObservationRef[],  // top 3 by ai_rank descending
  supporting: ObservationRef[],     // top 3
  verification: VerificationRef | null,
  aiRankHistory: number[]
}
```

Already exists as raw fields. Just render them in Hypothesis Sheet instead of raw payload.

### 5.4 Storage unchanged

No new fields. No schema change. Just surface existing reducer outputs.

---

## 6. AI Integration → SDK

### 6.1 Promote `@cognit/sdk`

Today `packages/sdk/src/index.ts` only re-exports `@cognit/core/paths`. Fill out:

```ts
// SDK surface (target)
export * from "@cognit/core/envelope"     // WrapEnvelope, WRAP_SCHEMA_VERSION
export * from "@cognit/wrap"              // appendInboxEnvelope, inboxFilename, runWrap
export * from "@cognit/verification"      // runVerification, types
export * from "@cognit/agent/decision"    // AgentDecision, AgentAction
export * from "@cognit/sdk/ai"            // high-level helpers (new)
```

### 6.2 High-level AI helpers (new module `packages/sdk/src/ai.ts`)

Wrap common sequences:

```ts
// AI helpers
export ensureSession(opts): Promise<SessionId>     // wraps `cognit session ensure`
export recordDecision(opts): Promise<void>         // wraps `cognit decision propose/accept`
export conclude(opts): Promise<void>               // wraps `cognit conclusion propose/verify`
export resume(opts): Promise<RecoveryEnvelope>     // wraps `cognit recovery`
export snapshot(sessionId): Promise<void>          // wraps `cognit snapshot`
```

Hook scripts (`hooks/claude-code/`, `hooks/codex/`, `hooks/opencode/`, `hooks/gemini-cli/`) refactored to import from `@cognit/sdk/ai` instead of shelling out to `cognit` CLI.

### 6.3 Result

Humans never invoke `session ensure` directly. They appear in docs as "hook entry points" with zero CLI examples.

---

## 7. Documentation Restructure

### 7.1 User-question-first table of contents

Replace current docs structure:

```
docs/
  index.md              ← (NEW) "Why Cognit exists" — answers in 90 seconds
  getting-started.md    ← user questions: install, use, find reasoning later
  why.md                ← (NEW) "Why did AI make this change?" — answers the #1 question
  recover.md            ← (NEW) "How do I undo or revisit?" — recovery story
  search.md             ← (NEW) "How do I find past reasoning?" — cognit recovery search
  hooks.md              ← unchanged (advanced audience)
  architecture.md       ← rename → "How Cognit remembers reasoning" (advanced)
  cli.md                ← unchanged (advanced audience)
  data-model.md         ← unchanged (advanced audience)
  events.md             ← unchanged (advanced audience)
  configuration.md      ← unchanged (advanced audience)
  storage.md            ← unchanged (advanced audience)
  dashboard.md          ← unchanged (advanced audience)
```

### 7.2 Voice rule

For every doc, the first paragraph must answer a user question, not describe a system component.

| Bad | Good |
|---|---|
| "Event types in Cognit follow a v1.2.0 schema…" | "When you ask 'why did the AI add this config?', Cognit shows the observation, the hypothesis it tested, and the check that confirmed it." |
| "The reducer applies events to SessionState…" | "How Cognit remembers reasoning: each tool call becomes an event; events fold into a graph you can search." |

### 7.3 Hooks / getting-started rewrite

`getting-started.md` should answer:
1. What is Cognit?
2. Why do I want it?
3. How do I install?
4. How do I use my AI tool normally?
5. How do I find reasoning later?
6. How do I uninstall?

Nothing about envelopes, schemas, reducers, event types, edge types.

---

## 8. Product Positioning

### 8.1 README weakness

Current top-of-README:
- "Remembers why your code looks like this." ← good
- "Git remembers WHAT. Jira remembers WHAT was planned. Cognit remembers WHY." ← good
- "Claude Code forgets the moment chat ends." ← good
- Missing: explicit comparison with Cursor, Windsurf, chat-log tools, Linear, Notion

### 8.2 New README structure (target)

```
# Cognit — Remembers why your code looks like this.

## Why not [Git | Jira | Claude Code | Cursor | chat logs]?
[4-row comparison table]

## What you get
- Searchable reasoning across every AI session
- Resume any investigation from the last conclusion
- Switch AI tools without losing context
- Local-only. SQLite. Nothing leaves your machine.

## Install (60 seconds)
git clone → pnpm install → pnpm build → pnpm link → cognit init
Init detects Claude Code / Codex / Gemini / OpenCode and wires hooks.

## Use your AI tool normally
claude
Dashboard: cognit dashboard

## Find reasoning later
cognit recovery search "why did we drop the JWT refresh"
→ opens session, shows hypothesis chain, verification result, decision rationale.

## What Cognit is not
- Not an agent framework.
- Not multi-agent.
- Not a workflow engine.
- Not a chat log.
- Not a replacement for Git, Jira, or your AI tool.

## How it works (one paragraph — advanced)
[unchanged]

## Documentation
- getting-started.md
- why.md (why did AI make this change?)
- recover.md (how do I undo or revisit?)
- search.md (how do I find past reasoning?)
```

### 8.3 Comparison table (target)

| | Git | Jira | Chat logs | **Cognit** |
|---|---|---|---|---|
| Tracks | what changed | what was planned | what AI said | **why AI changed it** |
| Captures at | commit | ticket | message | **tool call** |
| Searchable | code text | tickets | full text | **reasoning graph** |
| Survives | branch rebase | project end | chat close | **forever, local** |
| Replaces | — | — | — | **none — additive** |

### 8.4 Homepage copy improvements

- Lead with the question: "What did your AI actually think 3 months ago?"
- One-line differentiator: "Local-first reasoning memory for AI coding tools."
- No jargon in first 200 words.

---

## 9. Migration Strategy — Backward Compat

### 9.1 Hard rules

- No command deletion.
- No event-type removal.
- No DB schema migration.
- No config key removal.
- All old URLs resolve.

### 9.2 Layered rollout

| Layer | Change | Risk | Compat |
|---|---|---|---|
| 1. Visibility | Promote commands in `visibility.ts`; add `doctor`/`reset`/`update` | None | All old commands callable |
| 2. Aliases | Add `check`/`decide`/`conclude` wrappers | None | Old names still work |
| 3. Docs | Rewrite getting-started / add new top-level docs | None | Old docs preserved at same paths |
| 4. Dashboard | Move 5 routes into Settings → Advanced; preserve deep-link routes | Low | Old URLs redirect to Settings or render as dialog |
| 5. UI labels | Rename `Edge` → `Link`, `Verification` → `Check`, `Constraint Rule` → `Guardrail` in user copy | Low | Code identifiers unchanged |
| 6. Hide ids | Stop rendering ULIDs by default | None | "Copy id" still works |
| 7. SDK | Populate `@cognit/sdk`; refactor hook scripts | Low | Hook scripts still work (fallback to CLI shim) |
| 8. README | Rewrite top of README + add comparison table | None | Other docs unchanged |
| 9. Deprecations | Mark Theory / Experiment / `ai_rank_*` / `gravity.*` as experimental | None | Still callable |

### 9.3 Deprecation policy

- Mark `theory`, `experiment`, `gravity.*`, `ai_rank_*`, `hypothesis_ranked` as experimental.
- No removal timeline.
- `COGNIT_QUIET_DEPRECATIONS=1` still suppresses warnings.
- Optional packages: untouched.

### 9.4 What stays untouched (per scope lock)

- `init` workflow.
- Hook installation.
- Optional packages.
- DB schema.
- Config keys.
- Event envelope contract (v1.2.0).
- `@cognit/agent` supervisor loop.
- All CLI subcommands.

### 9.5 Rollout order

1. README + new top-level docs (no code risk).
2. `visibility.ts` promote (additive).
3. New `doctor`/`reset`/`update` commands (additive).
4. Aliases (`check`/`decide`/`conclude`) (additive).
5. Dashboard merges (preserves URLs).
6. UI label renames (cosmetic).
7. SDK population.
8. Hook script refactor to SDK.

Each step independently shippable. Each step reversibly rollback.

---

## 10. Acceptance Criteria

A new developer, after reading the new README + getting-started only, can answer:

1. What is Cognit? (1 sentence)
2. Why does it exist? (1 sentence + comparison table)
3. How do I install? (60 seconds, copy-paste)
4. How do I use it? (run my AI tool, open dashboard)
5. How do I find past reasoning? (`cognit recovery search <query>`)

Within **2 minutes** total, no docs beyond README + getting-started.

A typical user, after 1 failed AI change, can answer:

1. Why did AI make this change? (Timeline → row → Sheet → "Why" section)
2. Was it checked? (Check chip + status)
3. Can I revisit? (`Resume this investigation` button)

Within **30 seconds**, no docs beyond dashboard.

---

## 11. Out-of-Scope Findings

These are real but not part of this plan. Surface only, do not fix:

- `@cognit/sdk/src/index.ts` re-exports are TODO (only `paths` re-exported).
- `hypothesis_ranked` event floods timeline for AI-supervisor sessions.
- `recovery search` requires server running; not visible if user hasn't started it.
- `wrap` command vs `wrap` package name collision in docs.
- `COGNIT_QUIET_DEPRECATIONS` flag not mentioned in README.
- Optional packages: `llm`, `agent`, `wrap`, `verification`, `gravity`, `recovery`, `sdk` — none surface as opt-in choice; user gets all or nothing via `pnpm install`.

---

## 12. Sequencing (proposed)

| Sprint | Scope | Output |
|---|---|---|
| B.1 | README rewrite + new top-level docs | Docs only |
| B.2 | `visibility.ts` promote + 3 new commands | CLI only |
| B.3 | Aliases (`check`/`decide`/`conclude`) | CLI only |
| B.4 | Dashboard merges (5 routes → Advanced section) | UI only |
| B.5 | UI label renames + hide ids | UI only |
| B.6 | SDK population + hook refactor | Hooks only |

Each sprint independently shippable. Total: ~6 small PRs.