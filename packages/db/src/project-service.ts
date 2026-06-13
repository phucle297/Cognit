/**
 * ProjectService — read & idempotent insert against the `projects` table.
 *
 * Phase-1 tests inserted project rows directly. The CLI is the first
 * production caller that needs a real project row to exist in the DB
 * before it can create sessions. `ensure` is the bootstrap path:
 * idempotent, returns the existing row when one already exists, and
 * otherwise inserts a new row with a fresh ULID.
 *
 * Bead 2i adds this service. Bead 1i (cognit append / inbox) will also
 * rely on `ensure` when a write path needs a project id.
 */

import { Context, Effect, Layer } from "effect";
import { DbConnection } from "./context";
import { DbError, trySync } from "./errors";
import type { ProjectRow } from "./schema/rows";
import { Uuid } from "./ulid";

type DbConnService = Context.Tag.Service<typeof DbConnection>;
type UuidService = Context.Tag.Service<typeof Uuid>;

export interface ProjectEnsureInput {
  readonly name: string;
}

export interface ProjectServiceShape {
  /**
   * Idempotent. If a project row with `name = ?` already exists,
   * return it. Otherwise generate a fresh ULID and insert.
   * The `name` column is NOT unique in the schema, so we always read
   * first; in practice projects are 1-per-cognit.yaml.
   */
  readonly ensure: (input: ProjectEnsureInput) => Effect.Effect<ProjectRow, DbError>;
  readonly get: (id: string) => Effect.Effect<ProjectRow | null, DbError>;
  readonly byName: (name: string) => Effect.Effect<ProjectRow | null, DbError>;
}

export class ProjectService extends Context.Tag("@cognit/db/ProjectService")<
  ProjectService,
  ProjectServiceShape
>() {}

const nowIso = (): string => new Date().toISOString();

const fetchById = (conn: DbConnService, id: string): ProjectRow | undefined =>
  conn.handle.get<ProjectRow>("SELECT * FROM projects WHERE id = ?", [id]);

const fetchByName = (conn: DbConnService, name: string): ProjectRow | undefined =>
  conn.handle.get<ProjectRow>(
    "SELECT * FROM projects WHERE name = ? ORDER BY created_at ASC, id ASC LIMIT 1",
    [name],
  );

export const ProjectServiceLive: Layer.Layer<ProjectService, never, DbConnection | Uuid> = Layer.effect(
  ProjectService,
  Effect.gen(function* () {
    const conn: DbConnService = yield* DbConnection;
    const uuid: UuidService = yield* Uuid;

    return {
      ensure: (input) =>
        Effect.gen(function* () {
          const name = input.name.trim();
          if (name.length === 0) {
            return yield* Effect.fail(
              new DbError({ message: "project ensure: empty name", cause: undefined }),
            );
          }
          const existing = yield* trySync(
            () => fetchByName(conn, name),
            (e) => new DbError({ message: "project ensure: select", cause: e }),
          );
          if (existing) {
            return existing;
          }
          const id = yield* uuid.make();
          const createdAt = nowIso();
          yield* trySync(
            () =>
              conn.handle.run(
                `INSERT INTO projects (id, name, repo_url, created_at) VALUES (?, ?, ?, ?)`,
                [id, name, null, createdAt],
              ),
            (e) => new DbError({ message: "project ensure: insert", cause: e }),
          );
          // Re-read so the caller gets the row as stored (handles any
          // driver-side normalization of timestamps, defaults, etc.).
          const row = fetchById(conn, id);
          if (!row) {
            return yield* Effect.fail(
              new DbError({ message: "project ensure: row missing post-insert", cause: undefined }),
            );
          }
          return row;
        }),

      get: (id) =>
        Effect.sync((): ProjectRow | null => fetchById(conn, id) ?? null).pipe(
          Effect.mapError((e) => new DbError({ message: "project get", cause: e })),
        ),

      byName: (name) =>
        Effect.sync((): ProjectRow | null => fetchByName(conn, name) ?? null).pipe(
          Effect.mapError((e) => new DbError({ message: "project byName", cause: e })),
        ),
    };
  }),
);
