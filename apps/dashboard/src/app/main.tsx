/**
 * apps/dashboard/src/app/main.tsx — React entry point.
 *
 * Feature-Sliced Design: src/app/ is the top layer. It owns the
 * router, global providers, and design tokens. The dashboard
 * boots as a SPA on :6971 (same-origin with the API).
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router-dom";
import { router } from "./router";
import "./index.css";

const root = document.getElementById("root");
if (!root) {
  throw new Error("root element missing — check index.html");
}

createRoot(root).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
