# M3 — Product Validation: Dogfood Report

Date: 2026-06-29
Milestone: M3 (validation only — no product changes)
Author: dogfood session `01KW8PAHM5V71B1JBDAWTS8SXA`

## Executive summary

Cognit's core memory workflow is **usable**. Resume across sessions
works. Failed evidence is preserved. The generated CLAUDE.md is enough
for a fresh session to use Cognit correctly.

The product has **30+ commands Claude would never reach for**.
The public surface is dramatically oversized relative to natural
usage. This is the single largest product issue — fixing it improves
both discoverability and the cognitive load of every CLAUDE.md
revision.

Nothing in this report was implemented. Findings are evidence-driven.

---

## What worked

- **Resume via `cognit continue` across a fresh session pointer** —
  next-day simulation (rm of `.cognit/current-session`) immediately
  recalled 13 observations, 3 decisions, 2 verifications, 1
  conclusion. No hand-off required.
- **Failed verifications surface as a first-class memory** — the
  `verification_errored` event from a broken `echo` invocation still
  shows up in `cognit search` with a ✓ bullet "rejected — shown for
  context only". This is the exact behaviour a returning AI needs.
- **`cognit continue` ordering is right** — Doing → Verified →
  Decided → Open → Next matches what a returning agent needs to
  read in that priority.
- **Auto-session creation** — every `observation`/`decision`/
  `verification`/`conclusion` call auto-created the session without
  Claude ever needing to think about session lifecycle.

## What failed

- **Multi-token commands via the `verification` alias error without
  diagnostic** — `cognit verification "echo hello" --type exec`
  returned `verification_errored` with no captured stderr/excerpt
  explaining why. Single-token commands (`true`, `false`) work. The
  dogfood session captured this as observation; the user has no path
  to discover the root cause without reading source.
- **Three memory types, three verb patterns** — `decision propose`,
  `conclusion propose`, `verification <cmd>` directly. The verb
  `propose` is implicit in some, absent in others. Awkward.
- **Proposed decisions never become "Next"** — `cognit continue`
  only suggests a next step from an *accepted* decision or an open
  hypothesis. After proposing 3 decisions in one session with no
  acceptance step, the "Next:" line in `continue` is empty. Real
  dogsfood: I had decisions but no actionable next step on resume.
- **Decision lifecycle requires manual acceptance** — Claude has no
  natural trigger to run `decision accept --id <id>`. The proposed
  decisions stay `[pending]` forever. Verification, the only
  automatic acceptance mechanism, only links back to verification
  events, not conclusions.

## Memory audit (per-memory review)

The dogfood session captured 13 observations, 3 decisions, 2
verifications, 1 conclusion. Each was reviewed:

### Observations

| # | Text (truncated) | Redundant? | Actionable tomorrow? | Issue |
|---|---|---|---|---|
| 1 | "M3 dogfood: add vitest tier scripts…" | No | Yes (sets scope) | OK |
| 2 | "Cognit-40d already shipped…" | No | Yes (saves work) | OK |
| 3 | "During M2.1 the generated CLAUDE.md taught broken syntax…" | No | Yes (background) | OK |
| 4 | "Continue output shows verified+accepted+pending+…" | No | Yes (UX data) | OK |
| 5 | "Search returns ranked matches with ✓ bullets but…" | No | Yes (UX data) | OK |
| 6 | "Verification requires --type flag…" | No | Yes (UX data) | OK |
| 7 | "BUG: cognit verification 'echo hello' --type exec…" | No | Yes (bug) | OK |
| 8 | "GOOD: Failed verifications surface in cognit search…" | No | No (praise) | Borderline — should drop |
| 9 | "BAD UX: cognit search lists matches but does NOT print…" | No | Yes (UX) | OK |
| 10 | "MISSING: cognit continue output has no total count…" | No | Yes (gap) | OK |
| 11 | "GOOD: cognit continue shows 'Doing:'…" | No | No (praise) | Borderline — drop |
| 12 | "MISSING: cognit observation has no --tag/--category…" | No | Speculative | Borderline — delete |
| 13 | "CONFUSING: propose verb implicit in decision/conclusion…" | No | Yes (terminology) | OK |
| 14 | "DOGFOOD VALUE: capturing observations mid-task costs…" | No | Yes (workflow data) | OK |
| 15 | "MISSING: no quick way to list sessions in a project…" | No | Yes (gap) | OK |

**Observation #8 and #11 are praise** — they don't drive future
work. Future sessions will rediscover the positives on their own.
Borderline — leave for now.

**Observation #12 is speculative** — tagging is a feature request
from a single moment, not a validated gap.

### Decisions

| Text (truncated) | Actionable tomorrow? | Issue |
|---|---|---|
| "M3 dogfood report scopes validation only…" | Yes (sets scope) | OK |
| "Deprecate Cognit-22d, Cognit-40d…" | Yes (clear stale queue) | OK |
| "Ship M3 as docs/dogfood-report.md with top-10 issues…" | Yes (ship goal) | OK |

**All decisions are proposed, none accepted.** None of them become
"Next" on resume — see "What failed" above.

### Verifications

| Command | Result | Useful? |
|---|---|---|
| `pnpm --filter @cognit/cli build` (then later `true`) | errored, then passed | The errored one IS the bug-finding. The passing one (`true`) is filler — could have used `pnpm --filter @cognit/cli build` instead, but that errored initially for an unrelated cwd reason. |

### Conclusion

| Text | Actionable tomorrow? |
|---|---|
| "M3 dogfood complete: 13 observations, 3 decisions, 2 verifications (1 passed, 1 errored) recorded…" | Yes — concise close-out |

---

## Command usage audit

### Always used (during a normal development session)

| Command | Purpose | Trigger |
|---|---|---|
| `cognit init` | Bootstrap project | Once per project |
| `cognit observation` | Record noticed fact | Any moment |
| `cognit decision propose` | Record a choice | Non-trivial decision |
| `cognit verification` | Run + record evidence | After tests/lint/build |
| `cognit conclusion propose` | Close a decision with evidence | When decision closes |
| `cognit continue` | Resume context | Start of turn |
| `cognit search` | Look up prior reasoning | When topic recurs |

### Sometimes used (not reached for naturally)

| Command | Notes |
|---|---|
| `cognit decision accept/reject/supersede` | Manual acceptance — Claude has no trigger |
| `cognit conclusion verify/reject` | Manual verification — same gap |
| `cognit search --status <s>` | Filter flag never used |
| `cognit search --limit` | Never hit the default cap |
| `cognit search --root` | Never needed (auto-detect works) |
| `cognit continue --all` | Never used |

### Never used during dogfood (30+ commands)

| Category | Commands | Reason |
|---|---|---|
| Aliases of used verbs | `observe`, `verify`, `decide`, `conclude`, `check` | Duplicates of `observation`, `verification`, `decision`, `conclusion`. The "noun" alias exists next to the "verb" canonical. |
| Direct event-emit | `append`, `events`, `update` | Low-level — Claude reaches for the typed verbs above |
| Sessions | `session` (create/list/show/resume) | Auto-session means Claude never sees these |
| Diagnostics | `doctor`, `env`, `config`, `reset` | Operator tools, not Claude tools |
| Hygiene | `gc`, `redaction`, `recovery`, `snapshot`, `schema-dump` | Operator/maintenance |
| Lifecycle | `wrap`, `agent`, `ask`, `inbox` | Out of scope for Claude natural workflow |
| Research | `hypothesis`, `experiment`, `finding`, `theory`, `edge`, `constraint` | These are MEMORY TYPES but exposed only via `append` — Claude cannot reach them with one verb |
| I/O | `export`, `import`, `recovery` | Operator tools |
| UI | `dashboard`, `server` | Out of scope (M3 rules) |

### Proposed deprecations

These public commands were never reached for by Claude during a real
dogfood session. They should be candidates for deprecation or
re-packaging:

1. **`cognit observe`** — alias for `observation`. Redundant.
2. **`cognit verify`** — alias for `verification`. Redundant.
3. **`cognit decide`** — alias for `decision`. Redundant.
4. **`cognit conclude`** — alias for `conclusion`. Redundant.
5. **`cognit check`** — third alias for verification. Triply redundant.
6. **`cognit append`** — bypasses typed verbs. Only useful for tests.
7. **`cognit events`** — same as above.
8. **`cognit session`** — auto-session makes this invisible to Claude.
9. **`cognit wrap`** — never reached for in dogfood.
10. **`cognit ask`** — never reached for.

The current public surface is **~42 commands**. Natural Claude usage
is **7**. Aliases alone (5 duplicates of the same 5 nouns) account for
~12% of the surface.

---

## CLAUDE.md audit

Generated CLAUDE.md (after M2.1 reduction, 17 lines):

```
# Cognit — memory for this project

You have a local memory store. Use it yourself — never ask the user to run it.

| When | Command |
|---|---|
| You noticed something worth remembering | `cognit observation "<one line>"` |
| You are about to make a non-trivial choice | `cognit decision propose "<the choice>"` |
| You ran a test, lint, build, or typecheck | `cognit verification "<cmd>" --type test\|lint\|build\|typecheck` |
| You want to close a decision with that evidence | `cognit conclusion propose "<claim>"` |
| You start a turn, or come back after a break | `cognit continue` |
| You want prior reasoning on a topic | `cognit search "<query>"` |

- A session is auto-created on first call. Don't run `cognit session create`.
- Always run `verification` for tests, lint, build, typecheck.
- Run `cognit continue` at the start of each turn.
```

### What Claude did naturally

- ✅ Hit `observation` first when noticing facts.
- ✅ Hit `decision propose` before non-trivial choices.
- ✅ Hit `verification` after evidence was available.
- ✅ Hit `conclusion propose` to close decisions.
- ✅ Hit `continue` first thing.

### What Claude misunderstood

- ⚠️ Typed `verification "echo hello" --type exec` — expected
  single-quoted command to work. **The single-token pattern works;
  multi-token through the alias does not.** The CLAUDE.md does not
  warn about this. Document the `--` separator or accept quoted
  strings.
- ⚠️ Forgot `--type` would be required; got a cryptic `process.exit(2)`.
  CLAUDE.md shows the flag but Claude's natural typing is
  `verification "<cmd>"`. **Default `--type` to `exec`** would
  eliminate this footgun. CLAUDE.md could also show `exec` as the
  default.
- ⚠️ The `propose` word in `decision propose` and `conclusion
  propose` is implicit in the lifecycle but Claude had to remember
  it. CLAUDE.md should use the short form
  `cognit decision "<text>"` if propose is always the first action.

### What Claude ignored

- The "Always run `verification` for tests, lint, build, typecheck"
  rule was followed inconsistently because verification can fail
  silently (the bug above). The rule has no enforcement; it is a
  norm.

### Suggestions for CLAUDE.md (apply in M3.1+)

- Drop the explicit `propose` keyword from the trigger table. The
  short form `cognit decision "<text>"` is what Claude wants to
  type. (Implementation: make `propose` the default subcommand of
  `decision` and `conclusion`.)
- Document the `--type` default (`exec`) and warn that
  multi-token commands may need quoting in the user's shell.
- Remove the third bullet ("A session is auto-created on first
  call…") — it leaks a CLI detail Claude does not need to think
  about.

---

## Recall noise

- **Two verification rows labelled `true` in `continue`** — the
  output doesn't show the command's text in a way that distinguishes
  rows. Need a timestamp suffix or command-text excerpt.
- **Search ranks "just created" as a ✓ bullet** — a memory that was
  just created seconds ago gets the same ✓ "just created" treatment
  as one from a week ago. This adds noise to every row.

---

## Confusing terminology

- **`propose` vs `accept` vs `verify`** — the three lifecycle verbs
  don't map to natural language. "Propose a decision" sounds like
  "I'm not sure yet". The proposed-decision-then-accept dance is
  heavy for what Claude usually wants: "this is what I decided,
  here is the evidence, it's done".
- **`hypothesis` / `experiment` / `finding` / `theory`** — these
  memory types exist but Claude has no direct verb to create them
  (only `append --type`). They feel theoretical rather than
  practical.
- **`verified` / `accepted` / `pending` / `open` / `rejected`** —
  the trust vocabulary is correct but `[pending]` for a decision
  Claude just made feels like "you haven't accepted it yet", which
  is correct but feels bureaucratic.

---

## Top 10 issues, ranked by impact

### #1 — Oversized public surface (42 commands; 7 used)

**User impact.** Every new CLAUDE.md revision must consider 35
commands Claude might reach for. Discoverability is low — Claude
guesses at verbs. Documentation burden grows linearly with surface.

**Root cause.** Phase B.3 introduced `decision`/`decide`,
`conclusion`/`conclude`, `verify`/`verification`/`check` — five
names for the same three memory types. Memory type emitters
(hypothesis, theory, finding, edge, etc.) only accessible via
`append --type` — Claude has no natural verb for them.

**Proposed fix.** Pick ONE canonical name per memory type
(`observation`, `decision`, `verification`, `conclusion`, `continue`,
`search`). Deprecate aliases. Hide operator commands (`doctor`,
`gc`, `redaction`, `server`, etc.) from `--help` for Claude (or
move them under a `cognit admin` subcommand).

**Implementation effort.** S — delete aliases, update `--help`,
update CLAUDE.md. ~10 files. No DB changes.

**Expected benefit.** CLAUDE.md stays short. New Claude sessions
need to learn fewer verbs. Search results are less polluted by
operator noise.

### #2 — Verification accepts multi-token commands only via positional, errors silently

**User impact.** `cognit verification "echo hello" --type exec`
returns `verification_errored` with no captured stderr. Claude sees
"errored" but cannot diagnose. The session becomes a graveyard of
mystery failures.

**Root cause.** The `verification` alias forwarder strips one
`verify` keyword and forwards the rest. Multi-token commands wrapped
in shell quotes reach the engine as a single string element, which
the engine then tries to `spawn` as a binary path. Spawn fails
silently.

**Proposed fix.** Document `--` as required separator in CLAUDE.md.
Or: split the command on spaces inside the alias forwarder. Or:
require all verification commands to be tokenised as separate argv
elements and add a clearer error message when the engine sees a
single-element command with spaces.

**Implementation effort.** S — one alias forwarder tweak + one error
message + CLAUDE.md update.

**Expected benefit.** Every verification Claude attempts either
succeeds or produces a clear diagnostic. No more "what happened?"
moments.

### #3 — `decision` lifecycle forces manual acceptance; `continue` "Next" is empty without it

**User impact.** After proposing 3 decisions in a session and
running `cognit continue`, the "Next:" line is blank. A returning
AI has no actionable next step despite having 3 pending decisions.

**Root cause.** `ContinueSummary.suggestedNextStep` only considers
accepted decisions or open hypotheses. Pending decisions are
invisible to the suggestion engine.

**Proposed fix.** Treat `proposed` decisions with backing
verifications as effectively accepted for suggestion purposes. Or:
auto-accept a decision when a verification passes that is linked to
it. Or: surface proposed-but-unaccepted decisions in the "Next:"
list so the returning agent at least sees what was decided.

**Implementation effort.** S–M. Touches
`apps/cli/src/commands/continue.ts` and possibly the reducer in
`packages/db`.

**Expected benefit.** `cognit continue` always offers an actionable
next step. Returning AI never starts cold.

### #4 — `continue` shows no total memory count

**User impact.** A returning AI cannot tell whether a session is
thin (3 memories) or rich (50) without counting manually. Affects
confidence in the recall.

**Root cause.** `renderTrustLine` shows verified/accepted/pending/
open/rejected counts but not a raw total.

**Proposed fix.** Add `N memories` to the trust footer line.

**Implementation effort.** XS — one string concat in
`continue.ts`.

**Expected benefit.** Instant signal of session richness.

### #5 — `verification` requires `--type` flag with cryptic error if missing

**User impact.** Natural Claude typing `cognit verification "pnpm
test"` exits with `process.exit(2)` and a stderr message that names
the flag. Re-typing is annoying.

**Root cause.** `parseVerificationType` throws when `--type`
is missing.

**Proposed fix.** Default `--type` to `exec`. Users typing `pnpm
test` without `--type test` get a passing record (verified as
`exec`) instead of a hard fail. They can still pass `--type test`
for richer categorisation.

**Implementation effort.** XS — change default in
`verification.ts`.

**Expected benefit.** Eliminates a recurring friction point.

### #6 — Search doesn't surface the session goal inline

**User impact.** `cognit search "auth"` returns session ids and
truncated goals but not the full goal text. Claude has to run
`cognit continue <id>` separately to confirm the session is
relevant.

**Root cause.** `renderText` in `search.ts` truncates goal at 60
chars. No link/expansion affordance.

**Proposed fix.** Print full goal under each session header. Or:
add `--verbose` to search that prints full state.

**Implementation effort.** XS.

**Expected benefit.** One search call answers "is this the right
session?".

### #7 — No way to list sessions in a project

**User impact.** After a few days, an agent has 5+ sessions and no
way to see them all. `cognit search` only shows matches.

**Root cause.** `session list` exists but Claude has no trigger
for it; CLAUDE.md doesn't teach it.

**Proposed fix.** Either: (a) add `cognit continue --all` /
`cognit sessions list` that prints one line per open session with
goal + last activity. Or: have `cognit continue` fall through to a
listing when the pointer is stale AND no open sessions match a
query. Simplest: add a `cognit inbox` verb that the generated
CLAUDE.md teaches.

**Implementation effort.** M — new command or new flag.

**Expected benefit.** Returning agent sees the lay of the land
before diving into one session.

### #8 — Decisions/conclusions need a manual accept step that Claude has no trigger for

**User impact.** Claude proposes 5 decisions during a session, then
the session ends. All 5 are `[pending]`. None become "Next" on
resume. The 4-state lifecycle is invisible to Claude.

**Root cause.** The decision lifecycle is over-engineered for the
common case ("Claude decided, here's the evidence, it's done").

**Proposed fix.** Either: (a) auto-accept a decision when a linked
verification passes. (b) Remove the `accept` step and treat
`decision propose` as immediately `accepted`. (c) Make
`decision propose` accept a `--auto-accept` flag that becomes the
default for AI-driven sessions.

**Implementation effort.** M — touches reducer and command. Likely
needs a migration.

**Expected benefit.** Decisions reflect reality. `continue` "Next"
populates naturally.

### #9 — Observations have no tag/category to filter by topic

**User impact.** After 30 observations, finding "all observations
about auth" requires full-text search. The M2.1 ranking helps but
`continue` shows everything mixed together.

**Root cause.** Observation payload is just `{text, confidence}` —
no tags.

**Proposed fix.** Add `--tag` (repeatable) to `cognit observation`.
Store in payload. Add `--tag` filter to `cognit continue` and
`cognit search`. Two-line CLAUDE.md update.

**Implementation effort.** M — schema + service + CLI surface.

**Expected benefit.** Future sessions can scope by topic.

### #10 — Three different verb patterns across three memory types

**User impact.** `decision propose "x"`, `conclusion propose "x"`,
`verification "<cmd>"` — Claude has to remember which verb pattern
applies. Asymmetric feels accidental.

**Root cause.** `verify` lifecycle runs a subprocess so doesn't have
a `propose` step; the others do.

**Proposed fix.** Standardise: every memory type that has a
lifecycle starts with the noun. `cognit observation`, `cognit
decision`, `cognit verification`, `cognit conclusion`. Drop
`propose`. This is a backward-compatible deprecation.

**Implementation effort.** S — make `propose` the default
subcommand of `decision` and `conclusion`. Update CLAUDE.md.

**Expected benefit.** Claude learns one pattern.

---

## Summary

- **Resume works** — `cognit continue` reliably restores context
  across a fresh session pointer.
- **Failed evidence is preserved** — the `verification_errored`
  bug I hit during dogfood was itself captured and is queryable.
- **Public surface is ~6× too large** for natural Claude usage.
- **Lifecycle verb patterns are inconsistent** — `propose` vs
  direct.
- **Manual acceptance step is invisible** — Claude proposes but
  never accepts, leaving `continue` "Next" empty.

The next roadmap (M4+) should prioritise:
1. Surface reduction (#1)
2. Verification UX (#2, #5)
3. Decision auto-acceptance (#3, #8)

These three changes touch the largest number of dogfood findings and
unblock further usage. Everything else is incremental.