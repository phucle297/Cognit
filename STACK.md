# STACK

> Current tech stack for Cognit. Pinned versions are minimums. For naming, layout, code style → `CONVENTIONS.md`.

This file is the source of truth for _what_ the toolchain is. `plan.xml` `<scope>` no longer enumerates it — it points here.

---

## Runtime

| Layer       | Choice     | Min version |
| ----------- | ---------- | ----------- |
| Runtime     | Node.js    | 24 LTS      |
| Package mgr | pnpm       | 9           |
| Monorepo    | Turborepo  | 2           |
| Language    | TypeScript | 5.5+        |
| Module      | ESM        | —           |

**Why:**

- **Node 24 LTS** — native test runner, native `fetch`, stable `node:sqlite` later if needed.
- **pnpm 9** — content-addressable store, strict peer deps, fast install, hoisting off by default.
- **Turborepo 2** — incremental builds and remote cache. Pairs with pnpm workspaces via `pnpm-workspace.yaml`.
- **TypeScript 5.5+** — `const` type parameters, `using` declarations, better inference.
- **ESM** — `import` everywhere. No CJS interop for new code.

---

## Tooling

| Tool       | Role                         |
| ---------- | ---------------------------- |
| oxc        | Parser, transform, minify    |
| oxfmt      | Format                       |
| oxlint     | Lint                         |
| tsc        | Type-check only (`--noEmit`) |
| Vitest     | Test runner                  |
| tsx        | Dev run (TS in Node)         |
| Changesets | Versioning + release notes   |
| tsup       | Build packages to ESM        |

**Why:**

- **oxc** is Rust-fast. Replaces Babel/SWC/esbuild for transform where its feature set is enough.
- **oxfmt** is the Rust-native formatter. Replaces Prettier with one binary, zero config to start.
- **oxlint** is the Rust-native linter. Replaces ESLint; ships with sensible defaults; one binary, one config.
- **tsc --noEmit** is the type-check gate. We do not let tsc emit JS — oxc does that.
- **Vitest** — ESM-native, watch mode, Vitest config reuses Vite config.
- **tsx** — quick dev runs without a separate build step.
- **Changesets** — one PR per change, version bump + changelog generated at release.
- **tsup** — zero-config ESM bundler for `packages/*`.

---

## Backend

| Layer      | Choice        | Notes                                |
| ---------- | ------------- | ------------------------------------ |
| API        | Hono          | v0.1+                                |
| ORM        | Drizzle       | schema-first, type-safe queries      |
| Validation | Effect Schema | at every trust boundary              |
| FP runtime | Effect        | error channels, dependency injection |
| File watch | chokidar      | inbox adapter                        |
| Search     | fuse.js       | fuzzy keyword                        |

**Why:**

- **Hono** — small, fast, edge-ready, Effect-compatible middleware.
- **@hono/node-server** — Node adapter for Hono. `serve({fetch, hostname, port})` boots the same `Hono` app we test in-process.
- **Drizzle** — SQL-first. Queries stay readable, types are real, no codegen step.
- **Effect Schema** at the boundary — every event payload parsed before it lands in the store. Same `effect` package as the runtime; one ecosystem, no second dependency to drift.
- **Effect** — typed async, typed errors, dependency injection, resource management. Keeps the event store, reducer, and SDK honest about side effects.
- **chokidar** — the de facto file watcher for Node.
- **fuse.js** — fuzzy keyword search with weighted fields, zero infra.

### Service patterns

- **Effect Layer composition** — every service is a `Context.Tag` with a `*Live` Layer. Live layer = `Layer.effect(Tag, Effect.gen(function*() { ... deps ... return { methods } }))`. Composed via `Layer.provide(Layer.provide(EventStoreLive, leafs), DbConnectionLive(dbPath))` so each consumer's R channel is satisfied. `Layer.mergeAll` only ZIPS outputs; it does NOT satisfy R channels — use `Layer.provide` for that.
- **Migration runner** — `packages/db/src/schema/migrations.ts` exports `applyMigrations(db: SqliteHandle): Effect<{ applied }, DbError>`. Bootstraps `schema_version` (idempotent), reads current version, walks the ordered `MIGRATIONS` list, runs each in its own tx with `BEGIN`/`COMMIT`/`ROLLBACK`, upserts the version row. First migration is `1.0.0` and applies the current `TABLES_DDL`. Future versions prepend/append to the array.
- **Redaction path envelope** — `redactEvent` wraps payload/source in `{value: ...}` before calling `scanValue` so every hit has a non-empty `fieldPath` (e.g. `payload.value.text`). `redactValue` operates on the raw value to keep `payload_json` shape unchanged. Defensive filter on `fieldPath === ""` in event-store.ts remains as a guard.

---

## Server (`apps/server`)

| Layer           | Choice                  | Notes                                              |
| --------------- | ----------------------- | -------------------------------------------------- |
| HTTP framework  | Hono                    | routes + middleware                                |
| Node adapter    | @hono/node-server       | `serve({fetch, hostname, port})`                   |
| Runtime         | ManagedRuntime (Effect) | one runtime per server process, shared by handlers |
| Bus             | in-process Ref fan-out  | `EventBusLive` (typed `EventBus` from `@cognit/db`) |
| CLI flag parser | Commander               | `--host`, `--port`, `--root`                       |
| Config          | `cognit.yaml`           | `readConfig` (reused from `@cognit/cli`)           |

**Ports (phase 3d, may change):**

- **API**: `127.0.0.1:6971` (default; `--host 0.0.0.0` opens LAN bind)
- **UI (deferred, phase 4)**: `:6970`

**Auth model (phase 3d):**

- **Opt-in bearer only.** Default loopback bind is fully open — no token check. The `127.0.0.1` bind is the security boundary for local-first use.
- Auth activates ONLY when BOTH `server.api_token` is set in `cognit.yaml` AND the bind is non-loopback (`--host 0.0.0.0` or `server.host: 0.0.0.0`). Without the header → 401; with the correct `Authorization: Bearer <token>` → 200.
- This covers the future "MCP server bound to LAN" case without burdening local dev. Documented in `plans/phase-3.md` 3d section + `apps/server/test/auth-bearer.test.ts`.

**Runtime gotcha (must-read for contributors):**

- The `appLayer` MUST be wrapped in `ManagedRuntime.make(appLayer)` (not `Effect.provide(appLayer)` per-handler). With `Effect.provide`, the `EventBusLive` `Ref<subscribers>` is reconstructed on every request → SSE live-delivery is silently broken (subscriber queue is fresh + empty on every publish). `ManagedRuntime` builds the runtime ONCE and reuses it across requests. This is the difference between "SSE works in tests but not in production" and "SSE works everywhere".

**Phase 3 status (Cognit-5vl):** shipped. E2E coverage lives in `packages/cli/test/phase-3.e2e.test.ts` (AC1–3) and `apps/server/test/phase-3.server.e2e.test.ts` (AC4). Test counts: 149 db / 82 cli / 52 core / 15 server (targets 130+ / 60+ / 50+ / 10+).

---

## Frontend

| Layer      | Choice                          | Notes                                 |
| ---------- | ------------------------------- | ------------------------------------- |
| Framework  | React 19                        | local-first SPA                       |
| Build      | Vite 5                          | dev server, prod bundle               |
| Styling    | Tailwind CSS 4                  | utility-first, no global CSS          |
| Components | shadcn/ui                       | copy-paste, own the source            |
| Graph UI   | React Flow                      | knowledge + decision graph            |
| Forms      | react-hook-form + Effect Schema | type-safe, shared schemas with `core` |

**Why:**

- **React 19** — `use`, `useFormStatus`, `useOptimistic`, automatic batching.
- **Vite 5** — fast HMR, Rollup-based prod build, ESM dev server.
- **Tailwind 4** — CSS-first config, no `tailwind.config.js` required, faster.
- **shadcn/ui** — components live in our repo, copy-paste, no runtime dep, no version lock.
- **React Flow** — the standard for node-edge graph UIs in React.
- **react-hook-form + Effect Schema** — fast, controlled, schema-validated. Schemas live in `core` and are reused on the server, so the form types match the API.

---

## CLI

| Layer     | Choice        | Notes                     |
| --------- | ------------- | ------------------------- |
| Parser    | Commander.js  | command tree              |
| Streaming | Effect Stream | log output, follow events |

---

## Data store

| Layer        | Choice      | Notes                   |
| ------------ | ----------- | ----------------------- |
| Engine       | SQLite      | `better-sqlite3` driver |
| Migrations   | Drizzle Kit | SQL files               |
| Content addr | sha256      | artifact IDs            |

---

## What is NOT in the stack

Adding any of these needs a Changeset entry, a PR description, and a one-line "why this and not X".

- **No Bun runtime.** Node 24 LTS is the target.
- **No Next.js, no React Server Components.** Local-first SPA + Hono API.
- **No Redux, Zustand, Jotai, Recoil, MobX.** Server state via fetch, local state via `useState`/Effect. No global client store.
- **No Prisma, TypeORM, Knex, Kysely, MikroORM.** Drizzle only.
- **No zod, no valibot, no yup, no arktype, no typebox.** Effect Schema only. (Effect Schema is the schema module of the `effect` runtime — one dep, one ecosystem.)
- **No ESLint, no Prettier, no Biome.** oxc + oxfmt + oxlint only.
- **No class-based domain models in `core`.** Pure data + pure functions.
- **No `throw` in `packages/*`.** Effect error channels or typed `Result<E, A>`.
- **No tsc emit.** oxc handles transpile; tsc only type-checks.
- **No `any`.** `unknown` + narrowing.
- **No lodash, no ramda.** Effect + native ES cover what we need.
- **No mocha, no jest.** Vitest only.
- **No webpack, no Rollup config by hand.** Vite for apps, tsup for packages.
- **No Lerna, no Nx.** Turborepo only.
- **No class-based React components.** Function components only.
- **No global CSS.** Tailwind + a small `globals.css` for CSS variables and resets.

---

## Versioning

Stack versions pinned in:

- `package.json` `engines` (Node, pnpm)
- `package.json` `packageManager` (pnpm version, set via Corepack)
- `package.json` `dependencies` / `devDependencies` (caret-pinned per package)
- `pnpm-workspace.yaml` (workspace globs)
- `turbo.json` (task graph)

Bumping a major (Node 22 → 24, React 19 → 20) requires:

1. A Changeset entry under `.changeset/`.
2. CI green on the bump branch.
3. A one-paragraph note in the PR body explaining the why.

---

## Adding a new tool

Before adding, ask:

1. Is there an existing tool in the stack that does it?
2. Does it pull in a runtime, a build step, or a new package manager?
3. Is it Effect-compatible (if it lives in `packages/*`)?
4. Will it ship to the dashboard bundle? (Bundle size matters.)
5. Is it open source with an active maintainer?

If 1 is yes, do not add. If 2, 3, or 4 conflict, ask first. Document the decision in the PR description with a one-line "why this and not X".

---

## Related

- `CONVENTIONS.md` — naming, layout, code style, anti-patterns
- `ARCHITECTURE.md` — system view
- `plan.xml` — data model and feature spec
