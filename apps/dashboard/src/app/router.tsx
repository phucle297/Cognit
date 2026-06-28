/**
 * apps/dashboard/src/app/router.tsx — route table.
 *
 * Feature-Sliced Design: routes are declared in src/app/ because
 * they are app-wide composition. Page components live in
 * src/pages/ (FSD "pages" layer — one per route).
 *
 * Phase B.4 (plan-simplify-public-surface.md §3) collapses the
 * 5 deep-link-only routes (`/rules`, `/recovery-center`,
 * `/decision-graph`, `/verification`, `/ai-reasoning`) into a
 * single "Advanced" disclosure inside `/settings`. To keep
 * backward compat with existing bookmarks and any AI callers that
 * hard-code the old URLs, those 5 routes still resolve — but as
 * `replace` navigations to `/settings?advanced=<section>` so the
 * user lands on the new surface with the right sub-dialog open.
 *
 * The 4 public routes (`/`, `/timeline`, `/knowledge-graph`,
 * `/settings`) read query-string flags documented in plan §3.3:
 *   /knowledge-graph?kind=decision      → decision-only view
 *   /timeline?kind=verification_*       → kind-filter chip
 *   /knowledge-graph?ai=1               → AI-reasoning mode toggle
 *
 * Local-only tool — no login page, no auth gate. All routes render
 * inside <AppShell>, which provides the nav + content outlet.
 */
import type { ReactNode } from "react";
import { createBrowserRouter, Navigate } from "react-router-dom";
import { AppShell } from "@/widgets/app-shell";
import { OverviewPage } from "@/pages/overview";
import { TimelinePage } from "@/pages/timeline";
import { KnowledgeGraphPage } from "@/pages/knowledge-graph";
import { SettingsPage } from "@/pages/settings";

/**
 * Maps the 5 old deep-link routes to the matching Advanced
 * disclosure section id (the value the settings page reads from
 * `?advanced=…`). Keeping this table beside the route table
 * means a future rename has exactly one place to change.
 */
const ADVANCED_SECTION_FOR_OLD_ROUTE: Readonly<Record<string, string>> = {
  "/rules": "guardrails",
  "/recovery-center": "recovery",
  "/decision-graph": "decisions",
  "/verification": "checks",
  "/ai-reasoning": "ai",
};

/**
 * Wrapper component: redirects the old URL to `/settings?advanced=…`
 * on mount. Uses `replace: true` so the back button doesn't trap
 * the user on the settings page after navigating here from a
 * bookmark. The legacy page components (RulesPage,
 * RecoveryCenterPage, DecisionGraphPage, VerificationPage,
 * AiReasoningPage) stay registered as exports and are mounted
 * inside the Advanced disclosure dialogs — the route entries
 * above point the URLs at /settings instead so the public surface
 * is one route.
 */
const LegacyRedirect = ({ to }: { to: string }): ReactNode => {
  return <Navigate to={to} replace />;
};

export const router = createBrowserRouter(
  [
    {
      element: <AppShell />,
      children: [
        { path: "/", element: <OverviewPage /> },
        { path: "/timeline", element: <TimelinePage /> },
        { path: "/knowledge-graph", element: <KnowledgeGraphPage /> },
        { path: "/settings", element: <SettingsPage /> },
        ...Object.entries(ADVANCED_SECTION_FOR_OLD_ROUTE).map(([oldPath, section]) => ({
          path: oldPath,
          element: <LegacyRedirect to={`/settings?advanced=${section}`} />,
        })),
        { path: "*", element: <Navigate to="/" replace /> },
      ],
    },
  ],
  { basename: "/" },
);
