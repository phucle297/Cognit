# Phase 9 (Cognit-9.0) — Worker Inbox Adapter & Auto-capture — Audit

**Epic:** Cognit-9.0 — Phase 9 Worker Inbox Adapter + Auto-capture (v0.2)
**Plan:** `plan.xml` lines 660–720 (`worker_adapter`), 811–819 (phase 9 tasks)
**Status:** Audit only — no code changes. Three implementation sub-beads (9.1, 9.2, 9.3) scoped below.
**Done-when (from plan.xml:818):** Any external AI CLI can publish Cognit events, and `cognit wrap` can capture tool calls automatically.

---

## 1. Executive Summary

- Phase-9 *partial* code already exists: `packages/db/src/inbox.ts` (watcher + drain + per-file process), `apps/cli/src/commands/inbox.ts` (subcommand skeleton), and `packages/db/test/inbox.test.ts`. The skeleton is wired end-to-end but ships without three spec-required capabilities: (1) ULID/shape validation of `session_id` and filename, (2) Effect-Schema validation per event `type`+`version`, and (3) sidecar `<name>.reason.txt` on every error path. None of these are blockers — they are additive within the existing `processFile` shape.
- `cognit wrap` does not exist. The `packages/verification/src/{spawn,capture,artifact,index}.ts` quartet (361 lines) is the right pattern to mirror: it already wraps `child_process.spawn`, captures stdout/stderr, truncates at 1 MB, and writes a sha256-keyed artifact. The wrap command is essentially a producer-side wrapper that translates spawn output into inbox JSON files (or directly into `appendEvent` calls), not a new ingestion path.
- Hook documentation (`.claude/settings.json` PostToolUse/PreToolUse, plus Codex / OpenCode / Gemini CLI equivalents) is a docs-only deliverable. Spec says "document" — no runtime hook code ships in this phase. The risk is keeping hook snippets consistent across four CLI formats; one canonical example plus three short parallels suffices.
- The audit identifies 11 spec non-conformances (table in §11). 5 are inbox hardening, 4 are wrap, 2 are docs. All are scoped to ≤ 5 files each, so the three sub-beads are all MEDIUM or smaller per the orchestrator's complexity rule.
- Implementation order is 9.1 → 9.2 → 9.3 (justified in §8). 9.1 has no internal dep. 9.2 depends on the sidecar contract that 9.1 introduces. 9.3 is docs-only and depends only on the surface of 9.1 + 9.2 being stable.

---

## 2. Spec vs Current State

Mapping every requirement in `plan.xml` lines 663–710 (worker_adapter) and 811–819 (phase 9 tasks) to existing code. Status legend: `OK` = matches spec, `PARTIAL` = present but spec-non-conformant, `MISSING` = not implemented.

| # | Spec requirement (plan.xml:line) | Status | Current state (file:line) |
|---|---|---|---|
| 1 | `.cognit/inbox` is the write target (plan.xml:665) | OK | `apps/cli/src/paths.ts:74` (`inbox: path.join(dir, "inbox")`) |
| 2 | Single writer per session, multi-writer across sessions (plan.xml:666–667) | OK | No cross-session lock; each `processFile` runs via `Runtime.runFork` on its own fiber (`packages/db/src/inbox.ts:286`) |
| 3 | chokidar `awaitWriteFinish` with `stabilityThreshold=debounceMs` (plan.xml:668) | OK | `packages/db/src/inbox.ts:280` (`awaitWriteFinish: { stabilityThreshold: config.debounceMs, pollInterval: 50 }`) |
| 4 | File complete when name lacks `.tmp` AND mtime older than debounce_ms (plan.xml:668) | OK | `inboxIgnored` predicate drops `.tmp` (`packages/db/src/inbox.ts:208`); stability is enforced by `awaitWriteFinish` (same file:280) |
| 5 | Atomic-write protocol: `.tmp` → fsync → rename `.json` (plan.xml:669–672) | PARTIAL | Watcher accepts the post-rename `.json` (`packages/db/src/inbox.ts:283`); **no helper for producers exists** — `cognit wrap` must ship one |
| 6 | Invalid JSON → `_error/<name>.json` (plan.xml:675) | OK | `packages/db/src/inbox.ts:107` |
| 7 | Sidecar `<name>.reason.txt` on error (plan.xml:675) | MISSING | No `reason.txt` write anywhere in `processFile` (`packages/db/src/inbox.ts:83–195`); only structured logs |
| 8 | Unknown `session_id` → `_error/` (plan.xml:676) | MISSING | Watcher never inspects `session_id` shape (`packages/db/src/inbox.ts:130`); appendEvent accepts any string and FK-creates a session if absent |
| 9 | Schema-validation failure → `_error/` (plan.xml:677) | MISSING | Only presence checks at `packages/db/src/inbox.ts:130`; no Effect-Schema decode per `type`+`version`; payload passed through verbatim to `appendEvent` (line 154) |
| 10 | `actor_not_registered` → auto-register with default trust_score from `cognit.yaml actors.defaults.<type>` (plan.xml:678) | PARTIAL | Auto-registration works transitively via `SessionService.appendEvent → ensureActor` (`packages/db/src/event-store.ts:95–126`) but uses a hardcoded `DEFAULT_TRUST_BY_TYPE` (same file:74) — **`cognit.yaml actors.defaults.*` is not consulted** |
| 11 | `trust_score 0` sentinel always overwritten on registration (plan.xml:678) | PARTIAL | New rows use type default (`packages/db/src/event-store.ts:115`); but **no SQL UPDATE to overwrite a pre-existing 0 row** — if an actor was inserted with 0 by an earlier code path, it stays 0 |
| 12 | Emit `actor_registered` event (plan.xml:678) | MISSING | Schema defines `actor_registered` payload (`packages/db/src/event-schema.ts:254`), but no code emits one — see grep over `event-store.ts` |
| 13 | Redaction applied by `appendEvent`, not watcher (plan.xml:681) | OK | Watcher only forwards payload (`packages/db/src/inbox.ts:154`); redaction runs inside `appendEvent` per session-service |
| 14 | `cognit wrap -- claude-code ...` captures tool calls, exit codes, stderr (plan.xml:684–686) | MISSING | No `wrap` command exists; only mention is in a comment (`apps/cli/src/commands/verification.ts:183`) |
| 15 | `cognit inbox --watch` / `--process` (plan.xml:812) | OK | `apps/cli/src/commands/inbox.ts:73–74` |
| 16 | Debounce reads from config (plan.xml:667 default 200) | PARTIAL | Hardcoded `debounceMs: 200` in `buildInboxConfig` (`apps/cli/src/commands/inbox.ts:28`) — not pulled from `cognit.yaml` |
| 17 | Validate JSON event files against Effect Schema per type+version (plan.xml:813) | MISSING | No Effect Schema lookup keyed on `type`+`version` in `processFile` (`packages/db/src/inbox.ts:130`); `event-schema.ts` exists (`packages/db/src/event-schema.ts`) but is not invoked from the inbox path |
| 18 | Auto-register unknown actors with default trust_score from `cognit.yaml` (plan.xml:814) | PARTIAL (same as #10) | See #10 |
| 19 | Move invalid files to `_error/` (plan.xml:815) | OK | `packages/db/src/inbox.ts:107, 112, 132, 142, 177` (5 error exits) |
| 20 | Implement `cognit wrap` for arbitrary worker commands (plan.xml:816) | MISSING | No wrap command; see #14 |
| 21 | Document Claude Code / Codex / OpenCode / Gemini CLI hooks (plan.xml:817) | MISSING | No `docs/hooks/` directory; no settings.json examples |

---

## 3. 9.1 inbox — gaps to close

Scope: harden the existing watcher/drain/process pipeline against the spec. No new package, no new command surface.

- **`packages/db/src/inbox.ts:130`** — replace the presence-only check with an Effect Schema decode. The decode chain: envelope schema → type lookup in `packages/db/src/event-schema.ts` (line 298 has the `version` key) → payload schema. Failure → `_error/<name>.json` + sidecar `<name>.reason.txt` containing the decoder failure message.
- **`packages/db/src/inbox.ts:135–144`** — keep `decodeActorType` for `actor_type`, but route both schema failure and actor-type failure through the same sidecar helper. Today each branch emits its own log line and skips the sidecar (`packages/db/src/inbox.ts:136–143`).
- **`packages/db/src/inbox.ts:170–178`** — `appendResult.left` is currently collapsed to "append failed". Distinguish the four failure categories the spec names: `invalid_json`, `unknown_session_id`, `schema_validation_failure`, `actor_not_registered`. The session-service already has the typed error channel; map it.
- **`packages/db/src/inbox.ts:107, 112, 132, 142, 177`** — extract one helper, `moveToError(filePath, reason: string, logger)`, that does (a) `fs.rename` to `_error/<name>.json` (b) `fs.writeFile` of `_error/<name>.reason.txt`. Reason text is what the user / `cognit doctor` will see.
- **`packages/db/src/inbox.ts` (whole file)** — add ULID validation for `session_id`. The plan's example envelope (`plan.xml:692`) uses ULID format `01HXY...`. Use the existing `Uuid` service (already in `packages/db/src`) or a 26-char Crockford regex. Reject → `_error/` with `reason: "session_id must be ULID"`.
- **`packages/db/src/inbox.ts` filename** — enforce the spec's `<session-id>-<ulid>.json` pattern (plan.xml:670). Today any `.json` is accepted (line 283). Mismatch → reject. This catches producers that forgot the atomic-write dance.
- **`packages/db/src/event-store.ts:74`** — replace hardcoded `DEFAULT_TRUST_BY_TYPE` with a config-sourced map. New behavior: read `cognit.yaml` → `actors.defaults.<type>` at startup, fall back to the hardcoded map if unset. Surface the lookup on a `Context.Tag` so `ensureActor` can pull from R-channel instead of a module constant.
- **`packages/db/src/event-store.ts:107–113`** — add an `UPDATE actors SET trust_score = ? WHERE id = ? AND trust_score = 0` after the existing-row branch. This handles the trust-0 sentinel overwrite the spec calls out (plan.xml:678).
- **`packages/db/src/event-store.ts` (ensureActor)** — after a successful insert, append an `actor_registered` event via `SessionService.appendEvent` with `type: "actor_registered"` and `payload: { actor_id, actor_name, actor_type, trust_score }`. Schema entry already exists (`packages/db/src/event-schema.ts:254`).
- **`apps/cli/src/commands/inbox.ts:28`** — source `debounceMs` from `cognit.yaml` instead of hardcoding 200. Mirror how `sessionPolicyFromConfig` is loaded at line 39.
- **`packages/db/test/inbox.test.ts`** — extend the existing 335-line suite with cases for: (a) malformed JSON sidecar, (b) missing `session_id` sidecar, (c) unknown session_id path, (d) Effect Schema failure path, (e) trust-0 sentinel overwrite, (f) `actor_registered` event emission.

---

## 4. 9.2 wrap — gaps to close

Scope: new `cognit wrap -- <cmd> [args...]` command. Mirror the verification engine's spawn/capture/artifact pipeline. No new package — implementation lives in `apps/cli/src/commands/wrap.ts` and reuses `@cognit/verification` primitives.

- **New file: `apps/cli/src/commands/wrap.ts`** — register `program.command("wrap").argument("--").argument("<cmd>")...`. Reject if `--` not present (the spec literal syntax `cognit wrap -- claude-code ...` is non-optional). Use Commander's variadic positional after `--`.
- **`packages/verification/src/spawn.ts:63–126`** — reuse `spawnVerification` as the substrate. Do not reimplement spawn. The `signal` field becomes optional in the wrap context (Ctrl-C → abort the child).
- **`packages/verification/src/capture.ts:26–37`** — reuse `truncateExcerpt` for stderr; the spec calls out "stderr lines as observations" specifically, so keep the first 1 MB verbatim and tag the line source.
- **`packages/verification/src/artifact.ts`** — when combined stdout+stderr exceeds 1024 chars (already covered by `shouldWriteArtifact` at `packages/verification/src/capture.ts:36`), write the merged log to `artifacts/<sha256>.log` and reference it in the inbox JSON's `artifactRefs`.
- **New file: `packages/wrap/src/index.ts`** — pure producer of inbox JSON envelopes. Three output types: (a) `tool_call` (spawn start), (b) `observation_added` (per stderr line, batched), (c) `verification_passed` / `verification_failed` (terminal). Type-discriminated on `schema_version: "1.0.0"`.
- **Atomic-write helper** — factor `atomicWriteJson(filePath, obj)` into a shared util (suggested home: `packages/db/src/inbox-write.ts`). Steps: write to `<path>.tmp`, `fsync`, rename to `<path>.json`. The producer half of the inbox contract.
- **Decision: sink path** — choose between (a) write inbox JSON files the watcher will pick up, or (b) call `SessionService.appendEvent` directly. Option (a) is what the spec implies (plan.xml:684 "captures tool calls … as observations") and gives hooks a single ingestion path. Option (b) skips the watcher entirely but bypasses the atomic-write guarantee. Recommend (a) so `cognit wrap` exercises the same ingestion as every external worker — that is the whole point of Phase 9.
- **Per-stderr-line observation** — spec says "stderr lines as observations" (plan.xml:684). Treat each non-empty stderr line as a separate inbox file with `type: "observation_added"`. Batching (one file with N lines) is acceptable but reduces granularity in `cognit timeline`.
- **Test coverage** — `packages/wrap/test/index.test.ts`: spawn a known-good shell command, assert 1 terminal inbox file + N stderr-line files, assert `_error/` is empty, assert atomic-write helper fsyncs before rename. Negative test: spawn `false`, assert `verification_failed` terminal.
- **Reuse vs new code** — wrap is the first new package in Phase 9. To keep the dependency graph flat, wrap depends on `@cognit/db` (for `SessionService.appendEvent` in the dual-path fallback) and `@cognit/verification` (for `spawnVerification`, `writeArtifact`, `truncateExcerpt`). No new internal cycle. The atomic-write helper can live in either `packages/wrap/src/atomic-write.ts` (private) or `packages/db/src/inbox-write.ts` (shared with future producers). Recommend `packages/db/src/inbox-write.ts` so any future external producer can import the same primitive.
- **Session id provenance** — wrap must invent a session id for each invocation since it is invoked outside any pre-existing session. Two options: (a) `cognit session create --worker` first and pass `--session-id`, or (b) auto-create a session per wrap invocation. (a) gives the user control; (b) is zero-config. Recommend (a) as the default, (b) as a `--auto-session` flag.

---

## 5. 9.3 hooks — gaps to close

Scope: docs-only. No runtime hook code. Ship a single canonical guide plus four short provider-specific snippets.

- **New file: `docs/hooks/README.md`** — explain the contract: any tool that can shell out on `PostToolUse` and `PreToolUse` can publish to `.cognit/inbox` via a small bash wrapper (or via `cognit wrap` if the tool itself is the worker). Reference the atomic-write protocol in `plan.xml:669–672`.
- **New file: `docs/hooks/claude-code.md`** — canonical example. Settings snippet for `.claude/settings.json`:
  - `PostToolUse` matcher → shell command that pipes the tool-call JSON to a small Node helper writing into `.cognit/inbox/<session>-<ulid>.json.tmp` → fsync → rename.
  - `PreToolUse` matcher → shell command that emits `hypothesis_created` only if the file path is "unfamiliar" (heuristic: not in `.cognit/known-files.txt`).
- **New file: `docs/hooks/codex.md`** — Codex hook format (events on stdout, not in settings.json). Show the equivalent configuration: a shell wrapper invoked by Codex's `on_tool_use` callback that does the same atomic-write.
- **New file: `docs/hooks/opencode.md`** — OpenCode plugin entry. The plugin function receives `(tool, args)`, returns `(observation)`. Wrap to inbox JSON.
- **New file: `docs/hooks/gemini-cli.md`** — Gemini CLI's `.gemini/settings.json` is JSONC with the same hook shape as Claude Code. Copy the canonical example and adjust the matcher names per Gemini's vocabulary.
- **Cross-reference in `apps/cli/src/commands/inbox.ts`** — extend the command's `--help` text to point at `docs/hooks/README.md`. One-line edit, no behavior change.

---

## 5.1 Why the gaps exist today (context for the implementer)

The phase-9 partial code in `packages/db/src/inbox.ts` (291 lines) was written to land the watcher scaffolding early so other phases could exercise the path. It does the minimum to be useful: parse JSON, check presence of five fields, decode `actor_type`, hand to `appendEvent`, move on success/failure. Three intentional omissions explain most of the gaps above.

First, sidecar `<name>.reason.txt` files were deferred because they double the IO on the error path and the test suite at `packages/db/test/inbox.test.ts` (335 lines) already exercises the failure branches via structured logs. The spec requires them anyway (plan.xml:675), so 9.1 must add the helper.

Second, per-type Effect Schema validation was deferred to a later phase because `appendEvent` already runs a schema decode inside `SessionService.appendEvent` (via `RedactorLiveWithDefault` plus the type-keyed schema in `packages/db/src/event-schema.ts`). The watcher therefore trusts the store layer for shape — which is fine for correctness, but it means the watcher cannot produce a category-distinct `schema_validation_failure` reason. 9.1 needs the schema decode in the watcher too.

Third, `cognit.yaml actors.defaults.<type>` is not a configured shape yet. The config schema in `packages/core/src/config.ts` (referenced indirectly by `sessionPolicyFromConfig`) does not define an `actors` block. Adding it requires a config-schema migration in `packages/core` and an `ActorDefaults` `Context.Tag` that the DB layer can pull. That is the cleanest place to land the trust-0 sentinel rule too.

The wrap command does not exist because the verification engine's `runVerification` (`packages/verification/src/index.ts`) was always positioned as the substrate. Adding `cognit wrap` is essentially promoting `runVerification`'s spawn/capture/artifact pipeline to a CLI command and routing its output through the inbox contract instead of into a `verification_*` event directly.

Hook docs were never written because no external AI CLI was integrated yet. With Codex / OpenCode / Gemini CLI on the roadmap, the docs ship now.

---

## 6. Acceptance Criteria

Target set for the three sub-beads (9.1, 9.2, 9.3). 12 ACs total — 5 for inbox, 4 for wrap, 3 for hooks. Each AC is independently verifiable; quality gate per AC = one positive test + one negative test minimum.

**9.1 inbox (5 ACs)**

1. **AC 9.1.1** — Inbox JSON files are validated against an Effect Schema keyed on `type`+`version` before `appendEvent` is invoked. Schema-failure files move to `.cognit/inbox/_error/<name>.json` with a non-empty sidecar `.cognit/inbox/_error/<name>.reason.txt` whose first line is the decoder error. The compiled Schema lookup is cached per `(type, version)` tuple to keep decode cost flat under fan-out.
2. **AC 9.1.2** — All four spec-listed failure categories (`invalid_json`, `unknown_session_id`, `schema_validation_failure`, `actor_not_registered`) produce a sidecar `<name>.reason.txt` with a category-prefixed reason string. Verified by four unit-test cases in `packages/db/test/inbox.test.ts`. Each category maps to exactly one branch in `processFile` (`packages/db/src/inbox.ts:83–195`).
3. **AC 9.1.3** — Auto-registered actors read `trust_score` from `cognit.yaml → actors.defaults.<type>` when present, falling back to the type default. Pre-existing rows with `trust_score=0` are overwritten on next registration touch (the "0 sentinel" rule from plan.xml:678). The config-sourced defaults reach `ensureActor` via a new `ActorDefaults` `Context.Tag` on the R-channel; the hardcoded `DEFAULT_TRUST_BY_TYPE` at `packages/db/src/event-store.ts:74` is removed.
4. **AC 9.1.4** — A successful actor auto-registration emits an `actor_registered` event whose payload matches `packages/db/src/event-schema.ts:254`. The event is visible via `cognit events --type actor_registered` and has `actor_id`, `actor_name`, `actor_type`, `trust_score` populated. Emitted from the same `ensureActor` insert path.
5. **AC 9.1.5** — Inbox filename matches `<session-id>-<ulid>.json`; `session_id` decodes as ULID (26-char Crockford). Non-matching files move to `_error/` with a sidecar reason. `debounceMs` is sourced from `cognit.yaml`, not hardcoded at `apps/cli/src/commands/inbox.ts:28`.

**9.2 wrap (4 ACs)**

6. **AC 9.2.1** — `cognit wrap -- <cmd> [args...]` spawns `<cmd>` with `child_process.spawn` (reusing `spawnVerification` at `packages/verification/src/spawn.ts:63`), captures stdout/stderr, writes the atomic-write inbox files (`<session>-<ulid>.json.tmp` → fsync → rename), and blocks until the child exits. The `--` separator is mandatory; command rejects without it.
7. **AC 9.2.2** — Each non-empty stderr line produces a separate `observation_added` inbox file (or a single batched file with `payload.lines: string[]` — choose one and document the choice in `cognit wrap --help`). Verified by a unit test using `bash -c 'echo line1; echo line2 >&2'`. The choice and reasoning are captured in a comment near the producer.
8. **AC 9.2.3** — On child exit 0, wrap emits a `verification_passed`-shaped terminal inbox file with `{ exit_code, duration_ms, artifact_refs? }`. On non-zero exit, `verification_failed`. On `ENOENT`/`EACCES`/`EPERM` (raised by `spawnVerification` at `packages/verification/src/spawn.ts:32–38`), emit `verification_errored` with `error_code` set per the verification package's terminal mapping (re-exported from `packages/verification/src/index.ts`).
9. **AC 9.2.4** — Wrap writes `artifacts/<sha256>.log` for combined output > 1024 chars (reuse `shouldWriteArtifact` at `packages/verification/src/capture.ts:36`) and references it via `artifactRefs` on the terminal envelope. The sha256 is computed by `writeArtifact` at `packages/verification/src/artifact.ts`; no new hashing code is added.

**9.3 hooks (3 ACs)**

10. **AC 9.3.1** — `docs/hooks/README.md` exists and documents the atomic-write protocol (3 steps from plan.xml:669–672), the sidecar contract on error (`<name>.reason.txt`), and links to the four provider pages. Target length ≤ 80 lines.
11. **AC 9.3.2** — `docs/hooks/{claude-code,codex,opencode,gemini-cli}.md` each contain a runnable hook snippet with a `PostToolUse` → `cognit inbox` mapping. The Claude Code page additionally includes the `PreToolUse` → `hypothesis_created` example from plan.xml:686. Each page ≤ 50 lines.
12. **AC 9.3.3** — `cognit inbox --help` output mentions `docs/hooks/README.md` so a user running the command can discover the docs without an external search.

---

## 7. Test Coverage Plan

Target: each AC has at least one positive and one negative case before the corresponding sub-bead closes.

**9.1 inbox tests (`packages/db/test/inbox.test.ts` extension, +~250 lines)**

- `processFile` with valid ULID envelope → `_error/` empty, processed count == 1.
- `processFile` with malformed JSON → sidecar exists, first line is `invalid_json: <reason>`.
- `processFile` with non-ULID `session_id` → sidecar exists with `unknown_session_id`.
- `processFile` with valid envelope but payload missing required field for `hypothesis_created` → sidecar with `schema_validation_failure` and the schema error from `event-schema.ts`.
- `processFile` with `actor_type: "bogus"` → sidecar with `invalid_actor_type` (mapped to schema_validation_failure per the four-category list at plan.xml:674–678).
- `processFile` with unknown actor → `actor_registered` event appears in `events` table; `trust_score` matches `cognit.yaml actors.defaults.worker`.
- `processFile` re-process after manual `UPDATE actors SET trust_score = 0` → trust overwritten to type default on next appendEvent.
- `drainInbox` counts: 5 valid + 2 invalid → `{ processed: 5, errored: 2 }`.

**9.2 wrap tests (`packages/wrap/test/index.test.ts`, new file, ~150 lines)**

- Spawn `node -e "process.exit(0)"` → terminal inbox file with `verification_passed`, exit_code=0.
- Spawn `node -e "process.exit(1)"` → terminal inbox file with `verification_failed`, exit_code=1.
- Spawn `bash -c 'echo oops >&2'` → at least one `observation_added` inbox file from the stderr line.
- Spawn `definitely-not-a-binary-12345` → `verification_errored` with `error_code: "enoent"` (via the typed `SpawnError` at `packages/verification/src/spawn.ts:32`).
- Spawn with combined stdout+stderr > 1024 chars → `artifacts/<sha>.log` exists and is referenced by `artifactRefs`.

**9.3 hooks docs checks (no runtime tests; manual smoke)**

- Each `docs/hooks/*.md` snippet is copy-pasteable into the respective provider's settings file with no edits beyond the obvious (`<session-id>` placeholder, hook command path).
- `cognit inbox --help` mentions the docs path.

---

## 8. Implementation Order & Sub-bead Sizing

**Order: 9.1 → 9.2 → 9.3.** 9.1 closes the spec compliance gaps in the watcher first because 9.2 (wrap) and 9.3 (hooks) both depend on the sidecar contract (`<name>.reason.txt`) that 9.1 introduces. Shipping wrap before inbox is hardened would mean wrap writes fail silently for malformed envelopes.

**Sub-bead sizing (per orchestrator complexity rule, F=files, C=coupling):**

| Bead | Scope | F (est.) | C (est.) | Classification |
|------|-------|----------|----------|----------------|
| 9.1 inbox hardening | `packages/db/src/{inbox,event-store}.ts`, `apps/cli/src/commands/inbox.ts`, `packages/db/test/inbox.test.ts` | 4 | 4 | MEDIUM |
| 9.2 wrap | new `packages/wrap/src/{index,atomic-write}.ts`, `apps/cli/src/commands/wrap.ts`, `packages/wrap/test/index.test.ts` | 4 | 3 | MEDIUM |
| 9.3 hooks docs | new `docs/hooks/{README,claude-code,codex,opencode,gemini-cli}.md`, 1-line edit in `apps/cli/src/commands/inbox.ts` | 5 | 1 | SMALL |

**Dependencies:** 9.1 → 9.2 (sidecar contract). 9.2 → 9.3 (the hook docs reference `cognit wrap` and the inbox contract). 9.1 has no internal dep.

**Risk surface for the orchestrator:** 9.1 modifies `ensureActor` (`packages/db/src/event-store.ts:95`). Any other call site that depends on the hardcoded `DEFAULT_TRUST_BY_TYPE` (line 74) must be migrated in the same bead to keep behavior consistent. Grep before merge.

---

## 9. Risks & Ambiguities

- **`actor.defaults.<type>` source-of-truth.** Plan.xml:678 says "from cognit.yaml actors.defaults.<type>"; today the defaults are hardcoded in `packages/db/src/event-store.ts:74`. Migration: the config schema needs an `actors.defaults` shape that the DB layer can pull from the R-channel. A YAML roundtrip in `readConfig` + a new `Context.Tag<ActorDefaults>` is the cleanest path. Risk: the trust-0 sentinel rule (AC 9.1.3) interacts badly with manual `cognit actor trust set 0` — decide whether explicit 0 survives the overwrite.
- **Per-stderr-line vs batched observations (AC 9.2.2).** The spec says "stderr lines" (plural). Per-line inbox files = N fsyncs, which is slow for noisy tools. Batched is faster but loses granularity in `cognit timeline`. Recommend batched-by-N with a configurable cap (e.g., 50 lines / 64 KB), and surface the choice in `cognit wrap --help`.
- **Where wrap writes.** Plan.xml:684 implies wrap is a producer of inbox files, not a direct `appendEvent` caller. Choosing the inbox path keeps ingestion uniform with external CLIs (the Phase 9 promise), but adds a self-bootstrap cost: a worker running `cognit wrap` needs the watcher already running, or wrap must fall back to direct appendEvent. Pick the dual-path and document which mode is active per command invocation.
- **Hook docs scope creep.** Spec says "document Claude Code / Codex / OpenCode / Gemini CLI hooks". Each of those has its own hook vocabulary that drifts. Risk: docs go stale. Mitigation: keep snippets minimal (≤ 30 lines each) and pin a "last verified" date in each page so drift is obvious.
- **Effect Schema validation timing.** Running the per-`type`+`version` decode inside `processFile` (single-threaded per file) is fine, but if the watcher fan-out grows, the decode cost becomes the bottleneck. Mitigation: cache the compiled schema per (type, version) in a module-level `Map`. No behavior change, just a perf knob for 9.1.
- **Watcher back-pressure under burst load.** `runInboxWatcher` (`packages/db/src/inbox.ts:271`) fires `processFile` per file via `Runtime.runFork` with no concurrency cap. A producer that dumps 10 000 files at once will fork 10 000 fibers. Mitigation: a bounded semaphore (`Effect.withSemaphore`) on the `add` event handler in 9.1 — but only if a benchmark shows this matters. Not blocking.
- **`session_policy.everyN` interaction with auto-snapshot.** Each successful append via inbox fires the `SessionPolicy.everyN` snapshot trigger inside `SessionService.appendEvent`. For a busy worker, that means frequent snapshots. Not a correctness issue; just a perf / disk-usage tradeoff. Out of scope for Phase 9 unless explicitly raised.

---

## 10. References

- `plan.xml:660–720` — worker_adapter spec (atomic write, failure handling, auto-capture)
- `plan.xml:811–819` — Phase 9 task list and done-when
- `packages/db/src/inbox.ts` — existing watcher/drain/process (291 lines), all file:line citations land here
- `packages/db/src/event-store.ts:74–126` — `DEFAULT_TRUST_BY_TYPE` (74) and `ensureActor` (95–126)
- `packages/db/src/event-schema.ts:254` — `actor_registered` payload schema, also `:298` for the version-keyed map
- `packages/verification/src/{spawn,capture,artifact,index}.ts` — wrap substrate pattern (361 lines)
- `packages/verification/src/spawn.ts:63–126` — `spawnVerification` (substrate for AC 9.2.1)
- `packages/verification/src/spawn.ts:32–38` — `SpawnError` code mapping for AC 9.2.3
- `packages/verification/src/capture.ts:36` — `shouldWriteArtifact` threshold (1024 chars) for AC 9.2.4
- `apps/cli/src/commands/inbox.ts` — existing inbox subcommand (119 lines)
- `apps/cli/src/paths.ts:74–75` — `inbox` + `inboxError` path constants
- `apps/cli/src/commands/verification.ts:183` — sole existing comment referencing `cognit wrap`
- `docs/phase-8-results.md` — prior phase results format reference

---

## 11. Appendix — Spec non-conformance summary (one-line per gap)

For the orchestrator's quick triage. Each gap maps to exactly one AC above.

| Gap | Spec line | File:line (current) | AC |
|-----|-----------|---------------------|----|
| Sidecar `<name>.reason.txt` not written | plan.xml:675 | `packages/db/src/inbox.ts:107, 112, 132, 142, 177` (no sidecar write) | 9.1.2 |
| No Effect-Schema decode in watcher | plan.xml:677, 813 | `packages/db/src/inbox.ts:130` (presence-only) | 9.1.1 |
| No ULID validation on filename or `session_id` | plan.xml:670, 692 | `packages/db/src/inbox.ts:130, 283` | 9.1.5 |
| Hardcoded actor trust defaults | plan.xml:678, 708 | `packages/db/src/event-store.ts:74` | 9.1.3 |
| Trust-0 sentinel not overwritten on next touch | plan.xml:678 | `packages/db/src/event-store.ts:107–113` | 9.1.3 |
| `actor_registered` event not emitted on auto-register | plan.xml:678 | `packages/db/src/event-store.ts:107–126` (no appendEvent call) | 9.1.4 |
| `debounceMs` hardcoded, not from `cognit.yaml` | plan.xml:667 default 200 | `apps/cli/src/commands/inbox.ts:28` | 9.1.5 |
| `cognit wrap` command missing | plan.xml:684–686, 816 | n/a (no command) | 9.2.1–9.2.4 |
| No atomic-write helper for producers | plan.xml:669–672 | n/a | 9.2.1 |
| No per-stderr-line or batched observation policy | plan.xml:684 | n/a | 9.2.2 |
| Hooks docs missing | plan.xml:686, 817 | n/a | 9.3.1–9.3.3 |

---

## 12. Done-when verification (final acceptance)

Phase 9 is complete when **all** of the following hold. The 12 ACs above are the per-bead acceptance criteria; this section is the cross-bead "are we done" check.

1. All 12 ACs in §6 are closed in `bd` with a quality-gate pass.
2. The integration smoke test (a real AI CLI writes an inbox file via the atomic-write protocol; `cognit inbox --watch` processes it; `cognit events --type <x>` returns the event) succeeds end-to-end against a fresh `.cognit/` project.
3. `cognit wrap -- bash -c 'echo hi'` produces exactly one `observation_added` and one `verification_passed` inbox file (or the batched equivalent per AC 9.2.2).
4. A copy-paste of any `docs/hooks/*.md` snippet into the corresponding provider's settings file produces a `cognit events` row within one tool invocation. (Manual smoke; no automated provider test.)
5. `docs/phase-9-results.md` is written in the format of `docs/phase-8-results.md` (16-row AC checklist, test counts pre/post, quality-gate output).

