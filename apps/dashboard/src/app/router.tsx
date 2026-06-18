/**
 * apps/dashboard/src/app/router.tsx — route table.
 *
 * Feature-Sliced Design: routes are declared in src/app/ because
 * they are app-wide composition. Page components live in
 * src/pages/ (FSD "pages" layer — one per route).
 *
 * Local-only tool — no login page, no auth gate. All routes render
 * inside <AppShell>, which provides the nav + content outlet.
 */
import { createBrowserRouter, Navigate } from "react-router-dom";
import { AppShell } from "@/widgets/app-shell";
import { OverviewPage } from "@/pages/overview";
import { TimelinePage } from "@/pages/timeline";
import { KnowledgeGraphPage } from "@/pages/knowledge-graph";
import { DecisionGraphPage } from "@/pages/decision-graph";
import { VerificationPage } from "@/pages/verification";
import { RecoveryCenterPage } from "@/pages/recovery-center";
import { SettingsPage } from "@/pages/settings";

export const router = createBrowserRouter(
  [
    {
      element: <AppShell />,
      children: [
        { path: "/", element: <OverviewPage /> },
        { path: "/timeline", element: <TimelinePage /> },
        { path: "/knowledge-graph", element: <KnowledgeGraphPage /> },
        { path: "/decision-graph", element: <DecisionGraphPage /> },
        { path: "/verification", element: <VerificationPage /> },
        { path: "/recovery-center", element: <RecoveryCenterPage /> },
        { path: "/settings", element: <SettingsPage /> },
        { path: "*", element: <Navigate to="/" replace /> },
      ],
    },
  ],
  { basename: "/" },
);