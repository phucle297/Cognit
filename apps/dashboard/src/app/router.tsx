/**
 * apps/dashboard/src/app/router.tsx — route table.
 *
 * Legacy deep links redirect to Settings Advanced and forward
 * existing query params (e.g. session) so decision-graph bookmarks work.
 */
import type { ReactNode } from "react";
import { createBrowserRouter, Navigate, useLocation } from "react-router-dom";
import { AppShell } from "@/widgets/app-shell";
import { OverviewPage } from "@/pages/overview";
import { TimelinePage } from "@/pages/timeline";
import { KnowledgeGraphPage } from "@/pages/knowledge-graph";
import { SettingsPage } from "@/pages/settings";

const ADVANCED_SECTION_FOR_OLD_ROUTE: Readonly<Record<string, string>> = {
  "/rules": "guardrails",
  "/recovery-center": "recovery",
  "/decision-graph": "decisions",
  "/verification": "checks",
  "/ai-reasoning": "ai",
};

/**
 * Redirect old URL to `/settings?advanced=…` preserving other query
 * params (especially `session` for decision-graph).
 */
const LegacyRedirect = ({ section }: { section: string }): ReactNode => {
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  params.set("advanced", section);
  const qs = params.toString();
  return <Navigate to={`/settings?${qs}`} replace />;
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
          element: <LegacyRedirect section={section} />,
        })),
        { path: "*", element: <Navigate to="/" replace /> },
      ],
    },
  ],
  { basename: "/" },
);
