# Walkthrough: Investigating a Next.js memory leak

> **Scope:** this walkthrough shows the v0.2 output, including the
> Recovery Engine's "Last known state" and "Suggested next step" lines
> (Phases 7+8). On v0.1, those two lines are omitted; the rest of the
> session flow is identical. The Bootstrap-only path (phases 0-4) also
> works but produces a smaller recovery block.

A complete Cognit session from `init` to `resume`, in 11 steps and
27 events. Same scenario as the README quick start — Next.js dev server
memory grows unboundedly — but with every event listed and the full
recovery output six months later.

This is the verbose reference. For a 1-screen overview, see the README
quick start. For the raw event log table, scroll to the end.

## How to read this walkthrough

Each step shows three things:

- **Command** — the `cognit` CLI invocation
- **Output** — what `cognit` prints to the terminal
- **Stored** — the events appended to `.cognit/cognit.db`

Some commands take a relationship flag (`--tests`, `--belongs-to`,
`--supports`, `--contradicts`, `--based-on`, `--derived-from`). For the
`--belongs-to`, `--derived-from`, `--supports`, `--contradicts`, and
`--based-on` flags, the CLI emits a single `edge_created` event for the
relationship. The `--tests` flag is special: it is only accepted by
`cognit experiment add` (where it emits a `tests` edge) and by
`cognit verify` (where it records `linked_hypothesis_id` on the
verification record, not an edge). You can also write relationships
explicitly with `cognit edge add --type ...`.

After the walkthrough, the store has **27 events** (26 in the session +
1 `project_created`), **8 edges**, and **1 snapshot**.
The full event log table is at the bottom of this document.

---

## 1. Initialize

```bash
$ cd ~/code/nextjs-app
$ cognit init
Project "nextjs-app" created.
Wrote .cognit/cognit.yaml
Wrote .cognit/.gitignore
Wrote .cognit/cognit.db
```

Stored:

```
project_created
```

## 2. Create the session

```bash
$ cognit session create "Fix Next.js memory leak"
Session 01HXY8K9D4P2R7V3XJM5C6TBFA created.
This is now the active session.
```

Stored:

```
session_created
```

## 3. First observation

```bash
$ cognit observation add "Next.js reaches 18GB VmPeak after ~30 min of HMR"
Observation 01HXY8M3... recorded.
```

Stored:

```
observation_recorded
```

## 4. First hypothesis and theory

```bash
$ cognit theory add "HMR resource retention"
Theory 01HXY8N4... created.

$ cognit hypothesis add "Turbopack cache is leaking memory" \
    --belongs-to "HMR resource retention" --confidence 0.7
Hypothesis 01HXY8P5... created.
Edge: hypothesis 01HXY8P5... belongs_to theory 01HXY8N4...
```

Stored:

```
theory_created
hypothesis_created
edge_created (belongs_to)
```

## 5. A first, unverified finding

```bash
$ cognit finding add "Memory growth starts after HMR updates" \
    --derived-from 01HXY8M3... \
    --supports 01HXY8P5...
Finding 01HXY8Q6... created.
Edge: finding 01HXY8Q6... derived_from observation 01HXY8M3...
Edge: finding 01HXY8Q6... supports hypothesis 01HXY8P5...
```

Stored:

```
finding_created
edge_created (derived_from)
edge_created (supports)
```

## 6. Experiment that tests the hypothesis

```bash
$ cognit experiment add "Disable Turbopack and measure memory growth" \
    --tests "Turbopack cache is leaking memory"
Experiment 01HXY8R7... created.
Edge: experiment 01HXY8R7... tests hypothesis 01HXY8P5...
```

Run the actual test (regular shell, not a Cognit command):

```bash
$ NEXT_DISABLE_TURBOPACK=1 bun run dev
# ... wait 30 minutes, watch memory ...
```

Then record the result:

```bash
$ cognit experiment complete \
    --result "Memory still grows from 800MB to 14GB over 30 min with Turbopack off" \
    --contradicts "Turbopack cache is leaking memory"
Experiment 01HXY8R7... completed.
Edge: experiment 01HXY8R7... contradicts hypothesis 01HXY8P5...
```

Stored:

```
experiment_created
edge_created (tests)
experiment_completed (supports: [], contradicts: [01HXY8P5...])
edge_created (contradicts)
```

## 7. Reject the hypothesis

```bash
$ cognit hypothesis reject "Turbopack cache is leaking memory" \
    --reason "Disabling Turbopack did not stop memory growth" \
    --reason-type evidence
Hypothesis 01HXY8P5... rejected.
  state: rejected
  reason_type: evidence
  reason: "Disabling Turbopack did not stop memory growth"
```

Stored:

```
hypothesis_rejected (reason_type: evidence)
```

## 8. New hypothesis and a real verification

```bash
$ cognit hypothesis add "Module graph listener leak in HMR" \
    --belongs-to "HMR resource retention" --confidence 0.6
Hypothesis 01HXY8S8... created.
Edge: hypothesis 01HXY8S8... belongs_to theory 01HXY8N4...

$ cognit verify --type benchmark \
    --command "bun run bench:memory-without-hmr" \
    --tests "Module graph listener leak in HMR"
Verification 01HXY8T9... started.
Verification 01HXY8T9... passed (exit 0, 1820ms).
Artifact bench-memory-without-hmr.json attached (sha256: 9f3e...).
Verification 01HXY8T9... linked to hypothesis 01HXY8S8... (via linked_hypothesis_id).
```

Stored:

```
hypothesis_created
edge_created (belongs_to)
verification_started (linked_hypothesis_id: 01HXY8S8...)
artifact_attached
verification_passed
```

Note: the verification 01HXY8T9... carries `linked_hypothesis_id = 01HXY8S8...` on its
record — there is no `edge_created (tests)` for it. The `tests` edge type is
reserved for `experiment → hypothesis`; verifications are results, not tests.

## 9. Propose and verify a conclusion

```bash
$ cognit conclusion propose "Memory leak is in the HMR module graph, not Turbopack"
Conclusion 01HXY8VA... proposed.

$ cognit conclusion verify 01HXY8VA... --with 01HXY8T9...
Conclusion 01HXY8VA... verified.
Edge: conclusion 01HXY8VA... verified_by verification 01HXY8T9...
```

Stored:

```
conclusion_proposed
conclusion_verified
edge_created (verified_by)
```

Note: the conclusion `01HXY8VA...` is a separate entity from the hypothesis
`01HXY8S8...`. The hypothesis is still "active" (we did not emit a
`hypothesis_promoted` event for it). This is intentional: hypotheses are
explanations, conclusions are verified claims, and a verified conclusion
does not automatically retire every hypothesis it relates to. To retire
hypothesis `01HXY8S8...` explicitly, run `cognit hypothesis promote 01HXY8S8...`
next.

## 10. Accept a decision based on the conclusion

```bash
$ cognit decision accept "Disable HMR module caching in CI" \
    --reason "Memory leak source is the module graph, not Turbopack" \
    --based-on 01HXY8VA...
Decision 01HXY8WB... accepted.
Edge: decision 01HXY8WB... based_on conclusion 01HXY8VA...
```

Stored:

```
decision_proposed
decision_accepted (based_on_conclusion_ids: [01HXY8VA...])
edge_created (based_on)
```

## 11. Close the session

```bash
$ cognit session close
Session 01HXY8K9D4P2R7V3XJM5C6TBFA closed.
Snapshot created (25 events reduced to 1 snapshot).
```

Stored:

```
snapshot_created
session_closed
```

---

## Six months later: resume the investigation

```bash
$ cognit session resume "Next.js memory leak"
```

Recovery output (synthesised from events):

```
Previous session found (01HXY8K9D4P2R7V3XJM5C6TBFA, closed 2026-06-12).

Goal:
Fix Next.js memory leak

Rejected hypotheses:
- Turbopack cache is leaking memory
    reason_type: evidence
    "Disabling Turbopack did not stop memory growth"

Verified conclusions:
- Memory leak is in the HMR module graph, not Turbopack
    verified by: 01HXY8T9... (verification_passed, bench:memory-without-hmr)

Accepted decisions:
- Disable HMR module caching in CI
    based on: Memory leak is in the HMR module graph, not Turbopack

Last known state:
Root cause narrowed to HMR module graph. The "Turbopack cache leak" branch
was disproven by experiment 01HXY8R7... A new branch ("module graph
listener leak") was opened and has a passing verification, but the
hypothesis itself was never formally promoted.

Suggested next step:
Run `cognit hypothesis promote 01HXY8S8...` to formalise the promotion of
"Module graph listener leak in HMR" into a conclusion, OR open a new
experiment to narrow it further.

This new session 01HZG... is forked from 01HXY8... .
parent_session_id = 01HXY8K9D4P2R7V3XJM5C6TBFA
```

The new session has `parent_session_id` set, so the dashboard's
Recovery Center walks back through the full investigation history.

---

## The event store after the walkthrough

`.cognit/cognit.db` contains **27 events** (26 in the session +
1 `project_created`), **8 edges**, and **1 snapshot**. The verification
`01HXY8T9...` carries `linked_hypothesis_id = 01HXY8S8...` on its record
(not a row in the edges table).

### Events table (in order)

| #  | type                          | session_id  | actor            | confidence | notes                                        |
|----|-------------------------------|-------------|------------------|------------|----------------------------------------------|
| 1  | project_created               | -           | system:cognit    | -          | one-time at init                             |
| 2  | session_created               | 01HXY8...   | human:permees    | -          | goal: "Fix Next.js memory leak"              |
| 3  | observation_recorded          | 01HXY8...   | human:permees    | -          | 18GB VmPeak after 30 min of HMR              |
| 4  | theory_created                | 01HXY8...   | human:permees    | -          | "HMR resource retention"                     |
| 5  | hypothesis_created            | 01HXY8...   | human:permees    | 0.7        | "Turbopack cache is leaking memory"          |
| 6  | edge_created                  | 01HXY8...   | human:permees    | -          | belongs_to (H1 → T1)                         |
| 7  | finding_created               | 01HXY8...   | human:permees    | -          | "Memory growth starts after HMR updates"     |
| 8  | edge_created                  | 01HXY8...   | human:permees    | -          | derived_from (F1 → O1)                       |
| 9  | edge_created                  | 01HXY8...   | human:permees    | -          | supports (F1 → H1)                           |
| 10 | experiment_created            | 01HXY8...   | human:permees    | -          | "Disable Turbopack and measure memory..."    |
| 11 | edge_created                  | 01HXY8...   | human:permees    | -          | tests (E1 → H1)                              |
| 12 | experiment_completed          | 01HXY8...   | human:permees    | -          | supports: [], contradicts: [H1]              |
| 13 | edge_created                  | 01HXY8...   | human:permees    | -          | contradicts (E1 → H1)                        |
| 14 | hypothesis_rejected           | 01HXY8...   | human:permees    | -          | reason_type: evidence                        |
| 15 | hypothesis_created            | 01HXY8...   | human:permees    | 0.6        | "Module graph listener leak in HMR"          |
| 16 | edge_created                  | 01HXY8...   | human:permees    | -          | belongs_to (H2 → T1)                         |
| 17 | verification_started          | 01HXY8...   | system:cognit    | -          | bench:memory-without-hmr; linked_hypothesis_id=H2 |
| 18 | artifact_attached             | 01HXY8...   | system:cognit    | -          | sha256: 9f3e...                              |
| 19 | verification_passed           | 01HXY8...   | system:cognit    | -          | exit 0, 1820ms                               |
| 20 | conclusion_proposed           | 01HXY8...   | human:permees    | -          | "Memory leak is in the HMR module graph..."  |
| 21 | conclusion_verified           | 01HXY8...   | human:permees    | -          | by V1                                        |
| 22 | edge_created                  | 01HXY8...   | human:permees    | -          | verified_by (C1 → V1)                        |
| 23 | decision_proposed             | 01HXY8...   | human:permees    | -          | "Disable HMR module caching in CI"           |
| 24 | decision_accepted             | 01HXY8...   | human:permees    | -          | based_on: [C1]                               |
| 25 | edge_created                  | 01HXY8...   | human:permees    | -          | based_on (D1 → C1)                           |
| 26 | snapshot_created              | 01HXY8...   | system:cognit    | -          | state captured from events 1-25              |
| 27 | session_closed                | 01HXY8...   | human:permees    | -          | status: closed                               |

### Edges table (8 rows)

| #  | from        | edge_type     | to          | source                 |
|----|-------------|---------------|-------------|------------------------|
| 1  | hypothesis H1 | belongs_to  | theory T1   | step 4, --belongs-to   |
| 2  | finding F1   | derived_from | observation O1 | step 5, --derived-from |
| 3  | finding F1   | supports    | hypothesis H1 | step 5, --supports    |
| 4  | experiment E1 | tests      | hypothesis H1 | step 6, --tests       |
| 5  | experiment E1 | contradicts | hypothesis H1 | step 6, --contradicts |
| 6  | hypothesis H2 | belongs_to  | theory T1   | step 8, --belongs-to   |
| 7  | conclusion C1 | verified_by  | verification V1 | step 9             |
| 8  | decision D1   | based_on   | conclusion C1 | step 10, --based-on    |

Note: the verification V1 → hypothesis H2 link is stored on the verification
record as `linked_hypothesis_id`, not as a row in the edges table. The
`tests` edge type is reserved for `experiment → hypothesis`.

---

## Inspection commands

```bash
# List all closed sessions
$ cognit session list --status closed
01HXY8K9D4P2R7V3XJM5C6TBFA  closed  2026-06-12  Fix Next.js memory leak

# Show the full event timeline for a session
$ cognit session show 01HXY8K9D4P2R7V3XJM5C6TBFA
... prints all 27 events in order ...

# Show just the edges
$ cognit edge list --session 01HXY8K9D4P2R7V3XJM5C6TBFA
... prints 8 edges ...
```

## Export and import

```bash
$ cognit export --output nextjs-memory-leak-2026-06-12.tar.gz --include-artifacts
Wrote bundle (1.2 MB):
  - cognit.db (8 KB; 27 events, 8 edges, 1 snapshot)
  - artifacts/bench-memory-without-hmr.json (1.1 MB)
  - cognit.yaml (2 KB)
```

On another machine:

```bash
$ cd ~/code/nextjs-app-fork
$ cognit init
$ cognit import --input nextjs-memory-leak-2026-06-12.tar.gz --merge-strategy fork
Imported 1 session (forked as 01HZG...).
27 events, 8 edges, 1 snapshot, 1 artifact restored.
```

The new session 01HZG... is a sibling of any local sessions. Its
`parent_session_id` still points to 01HXY8... so the lineage is
preserved across the import.
