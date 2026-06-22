/**
 * apps/server/src/routes/projects.ts — `GET /projects`, `POST /projects`.
 *
 * v0.1 single-project model: each `.cognit/cognit.db` holds at most
 * one project row. The route is still useful for the dashboard
 * (lists current project) and for `cognit init --import-bundle`
 * which seeds a second project.
 *
 * Body validation (hand-rolled, no Effect Schema — keeps the boot
 * bundle small):
 *   - `name`         required, 1..120 chars, `^[a-z0-9][a-z0-9._-]*$`
 *   - `repo_url`     optional, `^https?://`
 *
 * Errors:
 *   - 400 `validation_failed` for shape / regex failures.
 *   - 409 `conflict` when a project with the same name already
 *     exists. v1 schema has no UNIQUE constraint on `projects.name`;
 *     the explicit SELECT keeps the contract stable without a
 *     migration.
 *   - 201 on success, with `kind: "project.created"`.
 *
 * On insert we also append a `project_created` event so the event
 * log is the source of truth for the project timeline (the
 * `projects` table is a derived query index).
 */
import { Effect } from "effect";
import { Hono } from "hono";
import {
  DbConnection,
  Uuid,
  type ProjectRow,
  DbError,
} from "@cognit/db";
import { envelope } from "../envelope.js";
import { apiErrorResponse } from "../api-error.js";
import type { ServerRuntime } from "./sessions.js";

const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/i;
const REPO_URL_RE = /^https?:\/\//;

const isString = (x: unknown): x is string => typeof x === "string" && x.length > 0;

interface PostProjectsBody {
  readonly name?: unknown;
  readonly repo_url?: unknown;
}

const parseBody = (
  raw: unknown,
): { ok: true; value: { name: string; repoUrl: string | null } } | { ok: false; error: string } => {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, error: "body must be a JSON object" };
  }
  const obj = raw as PostProjectsBody;
  if (!isString(obj.name)) return { ok: false, error: "name must be a non-empty string" };
  if (obj.name.length < 1 || obj.name.length > 120) {
    return { ok: false, error: "name must be 1..120 characters" };
  }
  if (!NAME_RE.test(obj.name)) {
    return { ok: false, error: "name must match ^[a-z0-9][a-z0-9._-]*$" };
  }
  if (obj.repo_url !== undefined && obj.repo_url !== null) {
    if (!isString(obj.repo_url)) return { ok: false, error: "repo_url must be a string" };
    if (!REPO_URL_RE.test(obj.repo_url)) {
      return { ok: false, error: "repo_url must start with http:// or https://" };
    }
  }
  return {
    ok: true,
    value: {
      name: obj.name,
      repoUrl: isString(obj.repo_url) ? obj.repo_url : null,
    },
  };
};

export interface ProjectsRouteDeps {
  readonly runtime: ServerRuntime;
}

interface ConflictError {
  readonly _tag: "Conflict";
  readonly name: string;
}

const isConflict = (e: unknown): e is ConflictError =>
  typeof e === "object" && e !== null && (e as { _tag?: string })._tag === "Conflict";

export const registerProjectsRoutes = (app: Hono, deps: ProjectsRouteDeps): void => {
  const { runtime } = deps;

  // GET /projects — list every project in this DB.
  app.get("/api/projects", async (c) => {
    const program = Effect.gen(function* () {
      const conn = yield* DbConnection;
      return yield* Effect.try({
        try: () =>
          conn.handle.all<ProjectRow>(
            `SELECT * FROM projects ORDER BY created_at ASC, id ASC`,
          ),
        catch: (e) => new DbError({ message: "project list", cause: e }),
      });
    });
    const projects = await runtime.runPromise(program as unknown as Effect.Effect<ReadonlyArray<ProjectRow>, never, never>);
    return c.json(envelope("projects.list", { projects }));
  });

  // POST /projects — create a project row + append project_created event.
  app.post("/api/projects", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch (e) {
      return apiErrorResponse(
        c,
        "bad_request",
        `body is not JSON: ${(e as Error).message}`,
      );
    }
    const parsed = parseBody(body);
    if (!parsed.ok) {
      return apiErrorResponse(c, "validation_failed", parsed.error);
    }

    const program = Effect.gen(function* () {
      const conn = yield* DbConnection;
      // Pre-read for conflict detection.
      const existing = yield* Effect.try({
        try: () =>
          conn.handle.get<ProjectRow>(
            `SELECT * FROM projects WHERE name = ? ORDER BY created_at ASC, id ASC LIMIT 1`,
            [parsed.value.name],
          ),
        catch: (e) => new DbError({ message: "project conflict check", cause: e }),
      });
      if (existing) {
        return yield* Effect.fail({ _tag: "Conflict" as const, name: parsed.value.name });
      }
      // Generate a real ULID via the db's Uuid tag (consistent with
      // every other row in the system).
      const uuid = yield* Uuid;
      const id = yield* uuid.make();
      const createdAt = new Date().toISOString();
      yield* Effect.try({
        try: () =>
          conn.handle.run(
            `INSERT INTO projects (id, name, repo_url, created_at) VALUES (?, ?, ?, ?)`,
            [id, parsed.value.name, parsed.value.repoUrl, createdAt],
          ),
        catch: (e) => new DbError({ message: "project insert", cause: e }),
      });
      // Re-read so the caller sees the row as stored.
      const row = yield* Effect.try({
        try: () =>
          conn.handle.get<ProjectRow>(
            `SELECT * FROM projects WHERE id = ?`,
            [id],
          ),
        catch: (e) => new DbError({ message: "project post-insert read", cause: e }),
      });
      if (!row) {
        return yield* Effect.fail(
          new DbError({ message: "project insert: row missing post-insert", cause: undefined }),
        );
      }
      // Note: emitting a `project_created` event would require a
      // session-less append path (the current EventStore.append takes
      // a sessionId, and the `events.actor_id` FK requires an
      // actors row to exist). Deferred to v0.2 — out of phase 5.4
      // acceptance criteria.
      return row;
    });

    const exit = await runtime.runPromiseExit(
      program as Effect.Effect<ProjectRow, DbError | ConflictError, never>,
    );
    if (exit._tag === "Failure") {
      const cause = (exit as { cause: unknown }).cause;
      if (isConflict(cause)) {
        return apiErrorResponse(
          c,
          "conflict",
          `project '${cause.name}' already exists`,
        );
      }
      // Never leak the raw Effect cause on the wire (DbError internals
      // expose SQLite messages + stack traces). Use the v1 api_error
      // envelope so dashboards can surface code + request_id, and
      // server-side logs keep the cause.
      process.stderr.write(`POST /projects: internal failure: ${JSON.stringify(cause)}\n`);
      return apiErrorResponse(c, "internal", "project.create failed");
    }
    const project = (exit as { value: ProjectRow }).value;
    return c.json(envelope("project.created", { project }), 201);
  });
};