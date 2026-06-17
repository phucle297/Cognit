/**
 * apps/server/src/routes/healthz.ts — `GET /healthz` (and `/health`)
 *
 * Returns `200 OK` with a small JSON body. No auth required even
 * when the bearer is enforced on other routes — the load balancer /
 * orchestrator probe must work regardless of token config.
 *
 * `plan.xml §api line 437` calls this endpoint `/health`; the
 * existing `/healthz` alias is kept for backward compatibility
 * (phase 3 client code). Both routes mount the same handler.
 */
import type { Handler } from "hono";
import { envelope } from "../envelope.js";

export const healthzHandler: Handler = (c) =>
  c.json(envelope("healthz", { status: "ok" }));

export const registerHealthz = (app: import("hono").Hono): void => {
  app.get("/healthz", healthzHandler);
  app.get("/health", healthzHandler);
};