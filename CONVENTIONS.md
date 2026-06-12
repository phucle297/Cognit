# CONVENTIONS

> Naming, layout, code style, anti-patterns. For the tools and their versions → `STACK.md`.

---

## File names

| What                     | Convention                 | Example                      |
| ------------------------ | -------------------------- | ---------------------------- |
| TypeScript source        | kebab-case                 | `event-store.ts`             |
| React component          | kebab-case.tsx             | `decision-graph.tsx`         |
| Test file                | `<name>.test.ts` colocated | `event-store.test.ts`        |
| Markdown (top-level doc) | UPPER-CASE                 | `ARCHITECTURE.md`            |
| Markdown (folder doc)    | lower-kebab                | `walkthrough-nextjs-leak.md` |
| SQL migration            | `NNNN_<name>.sql`          | `0001_init.sql`              |
| Config (JSON)            | kebab-case                 | `oxlint.json`, `oxfmt.json`  |
| Config (YAML)            | kebab-case                 | `cognit.yaml`                |
| Env file                 | `.env`, `.env.local`       | —                            |

---

## Identifier names

| What               | Convention          | Example                    |
| ------------------ | ------------------- | -------------------------- |
| Variables          | camelCase           | `sessionId`                |
| Functions          | camelCase           | `appendEvent`              |
| Classes            | PascalCase          | `RedactionRule`            |
| Types / interfaces | PascalCase          | `Hypothesis`               |
| Enums              | PascalCase          | `VerificationState`        |
| Enum members       | PascalCase          | `VerificationState.Failed` |
| Constants          | UPPER_SNAKE         | `MAX_DB_SIZE_MB`           |
| Event types        | snake_case          | `hypothesis_rejected`      |
| DB tables          | snake_case plural   | `events`, `sessions`       |
| DB columns         | snake_case          | `project_id`, `created_at` |
| URL paths          | kebab-case          | `/sessions/:id/recovery`   |
| CLI sub-commands   | space-separated     | `cognit hypothesis reject` |
| Effect schemas     | PascalCase + Schema | `HypothesisCreatedSchema`  |
| Effect Layers      | PascalCase + Layer  | `EventStoreLayer`          |
| Effect Errors      | PascalCase + Error  | `HypothesisNotFoundError`  |

---

## Code style

### TypeScript

- `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`, `noImplicitOverride: true`.
- No `any`. Use `unknown` + narrowing.
- `interface` for object shapes (open for extension). `type` for unions, intersections, mapped, conditional.
- Discriminated unions for events and state machines. The discriminator is `type` (string literal) or `_tag` for errors.
- `readonly` on every field that is not written after construction.
- `as const` for literal tuples and enum-like maps.
- Prefer `import type` for type-only imports. oxlint enforces.
- Branded types for IDs (`type SessionId = string & { readonly _brand: "SessionId" }`).

### Imports

- Absolute paths via `tsconfig.json` `paths`. No `../../../` chains. Max relative depth: 2.
- Group order: (1) node protocol, (2) external, (3) workspace packages, (4) relative. oxfmt sorts.
- No default exports in `packages/*`. Default export only for React components (one per file).
- No `import * as`. Named imports only.
- No barrel re-exports in hot paths. Barrels are for public `index.ts` only.

### Errors

- Library code (`packages/*`): no `throw`. Use Effect's error channel or a typed `Result<E, A>`.
- App code (`apps/*`, `cli`): `throw` is allowed at the very edge.
- Errors are tagged unions: `{ readonly _tag: "NotFound"; readonly id: string }`. Never bare `Error`.
- No `try { ... } catch {}`. Either rethrow as a tagged error, or handle in the error channel.
- No swallowed exceptions. `catch (e) { /* ignore */ }` is a CI failure.

### Effects and async

- Library code: Effect. Async, errors, and dependencies are all explicit in the type signature.
- App code: async/await is fine. `Promise<T>` for one-shot, Effect for streams and orchestration.
- No fire-and-forget promises. Every async path returns a value or an effect.

### Effect services

- A new service = one `Context.Tag` in `context.ts`, one `*Live` Layer exporting the implementation, one entry in the `leafs` merge in `layers/live.ts` if it has no dependencies, and a re-export from `index.ts`.
- Use `Layer.provide` to wire dependencies through R-channels. `Layer.mergeAll` only ZIPS outputs; it does NOT satisfy R-channels.
- Use `Effect.runtime<R>()` to materialize the current fiber's R into a `Runtime<R>`, then `runtime.runFork(effect)` for fire-and-forget from a chokidar callback or other non-Effect entry point. Never use `as Effect<...>` casts to strip R-channels.
- Errors are typed via the failure channel (`Effect.Effect<A, E, R>`). Wrap sync driver calls in `Effect.try` / `trySync` from `errors.ts` so failures become typed `DbError` and tx ROLLBACK fires correctly.

### Logging

- `console.log` is banned in `packages/*`. Use the logger from `core`.
- `console.error` allowed in `cli` for fatal startup failures only.
- `console.warn` allowed in `apps/server` for HTTP-level warnings.
- Never log `payload_json` of an event. Log the event id, type, and session id only.

---

## Layout

```txt
/
├─ apps/
│  ├─ server/          # Hono HTTP API
│  └─ dashboard/       # Vite + React 19
├─ packages/
│  ├─ core/            # types, Effect Schema, reducer, redaction, Effect services
│  ├─ db/              # Drizzle + appendEvent
│  ├─ cli/             # cognit binary
│  ├─ sdk/             # programmatic API for workers
│  └─ verification/    # subprocess engine
├─ examples/
│  ├─ cognit.yaml
│  ├─ inbox/
│  └─ walkthrough-*.md
├─ ARCHITECTURE.md
├─ CONVENTIONS.md
├─ STACK.md
├─ plan.xml
├─ README.md
├─ oxlint.json
├─ oxfmt.json
├─ turbo.json
├─ pnpm-workspace.yaml
├─ tsconfig.base.json
└─ package.json
```

### Per-package layout

```txt
<package>/
├─ src/
│  ├─ index.ts          # public surface
│  ├─ <module>.ts
│  └─ <module>.test.ts
├─ package.json
├─ tsconfig.json        # extends ../../tsconfig.base.json
└─ README.md            # only if non-obvious public surface
```

### `core` layout

```txt
packages/core/src/
├─ index.ts
├─ types/               # domain types (Hypothesis, Decision, …)
├─ schemas/             # Effect schemas, one per event type
├─ events/              # event type definitions + migrations
├─ reducer/             # pure replay function
├─ redaction/           # pattern engine
├─ errors/              # tagged error types
├─ services/            # Effect service definitions
└─ logger.ts
```

---

## Testing

- Vitest. ESM. Watch mode by default in dev.
- Tests colocated: `event-store.ts` ↔ `event-store.test.ts`.
- One `describe` per public function. One `it` per behavior, not per line.
- Assertions: `expect` only. No `assert.equal` from node.
- Coverage gate: 80% lines, 75% branches for `packages/core` and `packages/db`. Soft target elsewhere.
- Property tests for the reducer (events in, state out) and the redaction pipeline (input strings).
- Snapshot tests only for non-essential data (e.g. error messages). Never for reducer state.
- Use `vitest --run` in CI, `vitest` (watch) in dev.

---

## Commit messages

Conventional Commits.

```txt
<type>(<scope>): <subject>
```

- **Types:** `feat`, `fix`, `refactor`, `perf`, `test`, `docs`, `chore`, `build`, `ci`.
- **Scope:** package or area name (`core`, `db`, `cli`, `server`, `dashboard`, `inbox`, …).
- **Subject:** lowercase, imperative, no period, ≤ 72 chars.
- **Body:** wrap 100. Explain _why_, not _what_.
- **Footer:** `Refs:`, `BREAKING:`, `Co-Authored-By:`.

Example:

```txt
feat(db): make appendEvent the single redaction boundary

Every write path now routes through appendEvent so redaction runs
once, in one place, regardless of caller.

Refs: plan.xml#appendEvent-is-the-redaction-boundary
```

---

## Branches

- `main` — always green, always shippable.
- `feat/<scope>-<short>` — feature work.
- `fix/<scope>-<short>` — bug fixes.
- `chore/<scope>-<short>` — non-functional.
- `release/<version>` — release prep.

PRs: one logical change, green CI, one approval, squash-merge.

---

## Anti-patterns

Hard NOs. If you need one, write the case in the PR description and request a review.

- ❌ `any`. Use `unknown`.
- ❌ `throw new Error("...")` in `packages/*`. Use tagged errors.
- ❌ `console.log` in `packages/*`. Use the logger.
- ❌ `class` for domain models in `core`. Use data + functions.
- ❌ `eval`, `new Function(...)`.
- ❌ `document.querySelector` outside `apps/dashboard`.
- ❌ Direct `INSERT` / `UPDATE` / `DELETE` SQL in `apps/*`. All writes go through `appendEvent`.
- ❌ `process.env.X` in `packages/*`. Inject config.
- ❌ Default exports in `packages/*`.
- ❌ `let` for variables that don't change. Use `const`.
- ❌ `try { ... } catch (e) {}` empty catch. Either rethrow tagged or handle.
- ❌ Coupling `apps/*` to `packages/*` internals. Public surface is `index.ts`.
- ❌ Adding a dep without checking `STACK.md → What is NOT`.
- ❌ Mutating `payload_json` of an event after append. Events are immutable.
- ❌ Skipping Effect Schema at the trust boundary.
- ❌ Wrapping `scanValue` on a raw value without an envelope — produces empty `fieldPath` and silently drops redaction audit rows.
- ❌ Inline `key={i}` on React lists. Use stable ids.
- ❌ Tailwind `!important` (`!` prefix) in `apps/dashboard`. Refactor instead.

## Soft NOs

Acceptable, but write a one-line comment with the reason.

- ⚠️ `let` for accumulator variables in hot loops.
- ⚠️ `for` loop when `.map` would do — only for perf-critical paths.
- ⚠️ `as` cast — use a Schema parse instead.
- ⚠️ `// eslint-disable` / `oxlint-disable` — write the case in a code comment.

---

## Related

- `STACK.md` — the tools and their versions
- `ARCHITECTURE.md` — how the system fits together
- `plan.xml` — data model and feature spec
