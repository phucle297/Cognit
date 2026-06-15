/**
 * apps/server/src/routes/healthz.ts — `GET /healthz`
 *
 * Returns `200 OK` with a small JSON body. No auth required even
 * when the bearer is enforced on other routes — the load balancer /
 * orchestrator probe must work regardless of token config.
 */
import { Hono } from "hono";
import { envelope } from "../envelope.js";

export const registerHealthz = (app: Hono): void => {
  app.get("/healthz", (c) =>
    c.json(envelope("healthz", { status: "ok" })),
  );
};
