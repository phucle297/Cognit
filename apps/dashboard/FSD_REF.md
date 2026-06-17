# apps/dashboard — Feature-Sliced Design

The dashboard follows **Feature-Sliced Design** (FSD). Each file
carries a header comment naming its FSD layer. This doc is the
short reference for the rest of the project.

## Layers (top → bottom)

| Layer | Path | Owns |
|---|---|---|
| `app` | `src/app/` | Entry, router, providers, design tokens (`index.css`) |
| `pages` | `src/pages/` | One component per route |
| `widgets` | `src/widgets/` | Composite UI blocks (`AppShell`, `NavBar`) |
| `features` | `src/features/` | User actions (`auth/login`) |
| `entities` | `src/entities/` | Domain entities (events, sessions, …) |
| `shared` | `src/shared/` | Reusable infra: `ui/`, `lib/`, `api/` |

## Import rules

Higher layers may import lower ones. Lower layers MUST NOT
import higher ones. Concretely:

- `app/` may import from any layer
- `pages/` may import from `widgets/`, `features/`, `entities/`, `shared/`
- `widgets/` may import from `features/`, `entities/`, `shared/`
- `features/` may import from `entities/`, `shared/`
- `entities/` may import from `shared/`
- `shared/` imports nothing from the dashboard

## Path aliases

`@/app`, `@/pages`, `@/widgets`, `@/features`, `@/entities`,
`@/shared`, `@/lib` — all resolved by Vite (see `vite.config.ts`)
and TypeScript (see `tsconfig.json`). Use these instead of
relative `../../` chains.

## AC compatibility

The Phase 6 acceptance criteria name paths like
`src/components/ui/Button.tsx` and `src/components/AppShell.tsx`.
Those files exist as **one-line re-exports** of the FSD canonical
modules. The canonical source lives in the FSD layer
(`src/shared/ui/button.tsx`, `src/widgets/app-shell/index.tsx`,
etc.). The AC-required paths are kept so the original AC text and
the regression tests in 6.7 keep working.
