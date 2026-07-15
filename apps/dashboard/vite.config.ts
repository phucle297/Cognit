/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

/**
 * Vite config — apps/dashboard (Phase 6).
 *
 * Feature-Sliced Design layout (see FSD_REF.md):
 *   src/app/      app shell, providers, router
 *   src/pages/    full-page components (route targets)
 *   src/widgets/  composite UI blocks (AppShell, NavBar)
 *   src/entities/ domain entities (events, sessions, …)
 *   src/shared/   reusable infra: ui kit, lib helpers, config
 *
 * Same-origin dev: `pnpm dev` / `cognit dashboard` on :6970; the
 * proxy below forwards /api/* to the Hono API on :6971 (docker or
 * `cognit server`). SSE needs same-origin so the browser does not
 * block the stream as cross-origin.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    host: "127.0.0.1",
    port: 6970,
    strictPort: true,
    // Proxy /api → Hono. COGNIT_API_PROXY is set by `cognit dashboard`
    // when the preferred API port (6971) is busy (e.g. docker setup).
    proxy: {
      "/api": {
        target: process.env["COGNIT_API_PROXY"] ?? "http://127.0.0.1:6971",
        changeOrigin: false,
      },
    },
  },
  resolve: {
    alias: {
      "@/app": path.resolve(__dirname, "src/app"),
      "@/pages": path.resolve(__dirname, "src/pages"),
      "@/widgets": path.resolve(__dirname, "src/widgets"),
      "@/features": path.resolve(__dirname, "src/features"),
      "@/entities": path.resolve(__dirname, "src/entities"),
      "@/shared": path.resolve(__dirname, "src/shared"),
      "@/lib": path.resolve(__dirname, "src/lib"),
      "@/components": path.resolve(__dirname, "src/components"),
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./test/setup.ts"],
  },
});
