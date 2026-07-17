# Dashboard redesign: warm visual system + theme/graph reliability

**Date:** 2026-07-17  
**Status:** Approved for implementation planning  
**Issue:** Cognit-mf8  
**Scope:** Visual system + chrome + bug fixes (not full page layout rewrite)  
**App:** `apps/dashboard/` (+ minimal server fix for `/state` Map serialization)

---

## 1. Context

Cognit is a local-first memory layer for AI-assisted engineering. The dashboard is an optional loopback UI over one Cognit root: browse sessions, timeline, knowledge graph, and settings. It should feel like a trustworthy engineering notebook — warm, reliable, elegant, rounded — not a multi-tenant SaaS console.

### 1.1 Problems (validated)

| ID | Severity | Issue |
|----|----------|--------|
| T1 | P0 | Theme select saves to `localStorage` but never applies; CSS hard-pins light; no dark tokens |
| G1 | P0 | Graph nav has no session → permanent empty state |
| G2 | P0 | Decision graph redirect/dialog drops session |
| G3 | P0 | Force simulation updates wrong node array (layout static) |
| G4 | P1 | Alpha never decays → rAF can run forever |
| G5 | P0 | `/state` serializes Maps as `{}`; decision table/sheet empty |
| G6 | P1 | Edge-type filter uncheck inverts intent |
| G7 | P2 | Graph canvas height/`max-w-6xl` fights full-bleed |

### 1.2 Non-goals

- Full redesign of Overview / Timeline / Settings page structure
- Wiring global search
- New font packages or new UI libraries
- Completing FSD migration (`components/` → `shared/`)
- Multi-project switcher or auth
- Wiring `pageSize` across all lists (follow-up unless trivial)

---

## 2. Visual system

### 2.1 Metaphor

Local engineering notebook / workshop desk: paper-like surfaces, soft elevation, ember accent used sparingly for primary action and focus.

### 2.2 Light palette (named roles → CSS tokens)

| Role | Approx token target | Usage |
|------|---------------------|--------|
| Canvas | warm off-white `oklch(~0.97 0.01 85)` | `--color-background` |
| Surface | soft cream-white | `--color-card`, sidebar fill |
| Ink | warm near-black | `--color-foreground` |
| Muted | warm gray | `--color-muted-foreground` |
| Ember | existing amber `oklch(0.81 0.16 85)` | primary, brand, ring |
| Line | warm low-contrast border | `--color-border*` |

Status colors remain semantic (active/pending/failed/verified/archived); warm-shift backgrounds slightly if needed for canvas contrast. Do not invent a second parallel color system.

### 2.3 Dark palette

- Canvas: warm charcoal (not pure black)
- Surfaces: slightly lifted charcoal
- Ink: soft off-white
- Ember accent unchanged (not neon)
- Borders/shadows adjusted for dark surfaces
- Applied via `html.dark` or `html[data-theme="dark"]` redefining the same semantic tokens

### 2.4 Typography

- Keep system sans + mono stacks (no new deps)
- Quieter page titles; slightly more tracking on nav labels if needed for elegance
- Mono remains for IDs/timestamps

### 2.5 Radius & elevation

| Token | Current | Target |
|-------|---------|--------|
| `--radius-sm` | 0.25rem | 0.375rem |
| `--radius` | 0.5rem | 0.625rem |
| `--radius-lg` | 0.75rem | 1rem |
| `--radius-xl` | 1rem | 1.25rem |

- Cards / sheets: `rounded-xl` / `rounded-2xl`
- Pills / chips: full rounded
- Shadows: soft layered (existing scale, slightly warmer opacity)

### 2.6 Signature

Ember used only for: primary buttons, active nav, focus rings, live/SSE accents. No rainbow decoration.

### 2.7 Honesty

- Nav search: style as disabled/placeholder until wired (no false “works” affordance)
- Empty states: actionable copy when session is required

---

## 3. Theme behavior

### 3.1 Storage

Keep key `cognit.settings.v1` with `display.theme: "light" | "dark" | "system"`.

### 3.2 Apply path

1. On app boot (root layout / small theme module): read settings → resolve effective theme → set on `<html>` (`class="dark"` preferred for Tailwind compatibility, or `data-theme` if pure CSS vars only).
2. `system`: use `matchMedia('(prefers-color-scheme: dark)')` and subscribe to changes.
3. Settings Save: persist + re-apply immediately (no full reload required).
4. Replace empty dark `@media` block with real token overrides under `.dark` / `[data-theme="dark"]`.
5. Update `index.html` `color-scheme` meta dynamically or set both light/dark capability once dual themes exist.

### 3.3 UI

- Theme remains in Settings → Display only (no extra chrome control required this pass).
- Default when missing: `system` is fine once system is wired; prefer **light first paint then hydrate** from storage to avoid flash (optional FOUC mitigation: tiny inline script in `index.html` reading localStorage).

### 3.4 Acceptance criteria (theme)

- [ ] Changing theme to light/dark and Save updates UI without reload
- [ ] `system` follows OS preference and updates when OS changes
- [ ] Preference survives refresh
- [ ] No hard-pinned light-only CSS remaining for the main surface tokens

---

## 4. Chrome polish

### 4.1 Sidebar

- Surface uses surface token; active item uses brand/ember treatment (soft pill or rail)
- Larger corner radius on brand chip / nav items where components already use radius tokens
- No new nav items; keep public IA: Overview, Timeline, Graph, Settings

### 4.2 Nav bar

- Replace hard-coded border colors with `--color-border`
- Search input: explicit placeholder/disabled styling
- Version chip unchanged unless token-inconsistent

### 4.3 Shell width

- List pages: keep `max-w-6xl`
- Knowledge graph (and decision graph if full page): allow full width / full remaining height so canvas is usable

### 4.4 Shared primitives

- Prefer token-driven radius on Button, Card, Badge, Input, Dialog (adjust CVA/class defaults to larger radius where one-line changes suffice)
- No drive-by component API changes

### 4.5 Acceptance criteria (chrome)

- [ ] Shell/sidebar/topbar read as warm, rounded, consistent tokens
- [ ] Graph route not crushed by list-page max-width
- [ ] Search does not look like a working global search

---

## 5. Graph reliability

### 5.1 Session continuity (G1)

- Persist last graph session id (e.g. `cognit.graph.lastSession` or reuse a small session context key)
- Resolve session for Graph page in order: `?session=` → last session → empty
- Sidebar Graph link may omit session; page must not be permanently stuck if a recent session exists
- Overview and/or Timeline: “Open graph” (or equivalent) navigates to `/knowledge-graph?session=<id>`
- Graph page: compact session selector (list recent sessions) when empty or to switch

### 5.2 Physics (G3, G4)

- Force simulation must update the same node array React Flow renders (do not animate from unmutated copies)
- Alpha must decay toward target / min and stop rAF when cool
- Tests: positions change after ticks; alpha eventually ≤ min

### 5.3 Edge filter (G6)

- Empty set = show all (keep)
- First uncheck when set is empty: seed all edge types, then remove the unchecked one
- Checkbox checked state matches visibility intent

### 5.4 Decision graph (G2, G5)

- Redirect `/decision-graph` → `/settings?advanced=decisions` **must forward** `session` (and other relevant query params)
- Server: `/state` (and any other JSON path that returns live Maps) must serialize Maps to plain objects (same approach as export path)
- UI: decision view should filter to decision entities where product expects decision-only graph
- Prefer usability: if decision graph remains dialog-hosted, ensure session can be supplied; optional follow-up is promoting decision view to KG `?kind=decision` — **in scope only if low risk while fixing G2**

### 5.5 Canvas layout (G7)

- Prefer `h-full` / flex parent over fixed `h-[600px]` where page already claims viewport height
- Shell exception for graph routes as in §4.3

### 5.6 Acceptance criteria (graph)

- [ ] From Overview/Timeline with a session, user can open Graph and see nodes (when data exists)
- [ ] Graph with last session remembered works after refresh without query param
- [ ] Session selector works when no session
- [ ] Physics layout moves nodes and settles
- [ ] Edge type uncheck hides only that type
- [ ] Decision advanced view with session shows decision state (not empty Maps)
- [ ] Existing graph tests updated/extended; no false green from over-mocked state only

---

## 6. Architecture notes

### 6.1 Theme module

- Small module under `shared/` or `app/` (e.g. `applyTheme`, `readDisplaySettings`, `subscribeSystemTheme`)
- Call from shell root (router layout) so all routes inherit
- Settings page imports apply helper on save

### 6.2 Session for graph

- Prefer query param as source of truth when present; last-session as fallback
- Do not introduce multi-project session global that breaks “one root per process”

### 6.3 Server change (G5)

- Minimal: serialize session state Maps on the JSON response path used by the dashboard
- No schema migration; pure response shaping
- Add/adjust server test proving Maps become objects (not `{}`)

### 6.4 Files likely touched (estimate)

| Area | Paths |
|------|--------|
| Tokens | `src/app/index.css`, `index.html` |
| Theme | new small theme helper; `widgets/app-shell` or router root; `pages/settings.tsx` |
| Chrome | `widgets/sidebar`, `widgets/nav-bar`, `shared/ui/{button,card,input,badge}` as needed |
| Graph | `pages/knowledge-graph.tsx`, `components/GraphCanvas.tsx`, `lib/force-simulation.ts`, `components/GraphControls.tsx`, Overview/Timeline links |
| Decision | `router.tsx`, `pages/decision-graph.tsx`, server sessions route |
| Tests | Settings theme apply; graph session; physics; server state serialization |

---

## 7. Testing plan

1. **Unit:** force-simulation alpha decay + node mutation; theme resolve (light/dark/system)
2. **Component/integration:** Settings save applies `class`/`data-theme`; KnowledgeGraph with session from storage; edge filter toggle
3. **Server:** `/state` Maps → objects
4. **Regression:** existing dashboard test suite green; update mocks only where they encoded wrong assumptions

---

## 8. Implementation order

1. Tokens + dark overrides + theme apply path (T1)
2. Session continuity + selector + deep links (G1)
3. Physics + alpha (G3, G4)
4. Edge filter (G6)
5. `/state` serialization + decision session forward (G5, G2)
6. Shell width + canvas height (G7)
7. Chrome radius/token polish on primitives
8. Tests + quality gate

---

## 9. Risks

| Risk | Mitigation |
|------|------------|
| FOUC on theme | Optional inline script reading localStorage before paint |
| Dark contrast on status/graph colors | Spot-check graph node colors in dark; adjust only if unreadable |
| Server serialization misses nested Maps | Reuse existing `sortKeysDeep` / Map walk from export |
| Scope creep into page redesign | Strict non-goals; page layout changes only for graph usability |

---

## 10. Success definition

Dashboard feels warm, rounded, and reliable; light/dark/system theme actually changes the UI; Graph is reachable and usable with a session; physics and edge filters behave correctly; Decision advanced view can show real decision state when a session is provided.
