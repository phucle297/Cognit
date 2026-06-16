/**
 * artifact-repo — storage-GC helpers for the `artifacts` table.
 *
 * Phase 4 / 4c (gc CLI) is the only intended caller. `listArtifacts`
 * produces the candidate set; `markArtifactArchived` flips the
 * `archived_at` column. Neither is an event-store operation —
 * garbage collection is a storage concern, not a domain concern, so
 * we do NOT emit `artifact_archived` events here. The trade-off is
 * recorded in the CLI's `--dry-run` output and in the doc comment on
 * `gc.ts`. If a future product story needs to audit GC, switch to a
 * dedicated `storage_gc_run` event and append it from the CLI after
 * the loop completes.
 *
 * Index usage: every query touches `artifacts.archived_at` (the
 * `idx_artifacts_archived` index added in migration 0002 covers
 * `archived_at` for the live set; the `archived_at IS NULL` filter
 * collapses to a partial range scan, which is what the planner
 * chooses for both `list` and the `WHERE id = ?` update path).
 */
import { Context, Effect, Layer } from "effect";
import { DbConnection } from "./context";
import { DbError, trySync } from "./errors";
import type { ArtifactRow } from "./schema/rows";

export interface ListArtifactsQuery {
  /** When set, restrict to a single session. */
  readonly sessionId?: string;
  /**
   * When true (default), exclude rows with `archived_at IS NOT NULL`.
   * `false` returns every row including the archive history.
   */
  readonly archived?: boolean;
  /**
   * When set, only return rows whose `created_at` is strictly older
   * than `now - olderThanDays * 24h`. Used by gc to find stale
   * artifacts.
   */
  readonly olderThanDays?: number;
}

export interface ArtifactRepoShape {
  readonly listArtifacts: (
    q: ListArtifactsQuery,
  ) => Effect.Effect<ReadonlyArray<ArtifactRow>, DbError>;
  /**
   * Direct UPDATE: set `archived_at` to the provided ISO timestamp.
   * Returns the number of rows changed (0 if the id is unknown or
   * already archived).
   */
  readonly markArtifactArchived: (
    id: string,
    archivedAt: string,
  ) => Effect.Effect<number, DbError>;
  /**
   * Direct DELETE: remove the row entirely. Used by the gc CLI when
   * `cleanup.unreferenced_action = "delete"`. Returns the number of
   * rows removed (0 if the id is unknown).
   */
  readonly deleteArtifact: (id: string) => Effect.Effect<number, DbError>;
}

export class ArtifactRepo extends Context.Tag("@cognit/db/ArtifactRepo")<
  ArtifactRepo,
  ArtifactRepoShape
>() {}

const buildListSql = (q: ListArtifactsQuery): { sql: string; params: unknown[] } => {
  const where: string[] = [];
  const params: unknown[] = [];
  // Default `archived = false` so callers that pass nothing get only
  // the live set. The CLI passes `archived: true` to enumerate the
  // archive when reporting.
  const archived = q.archived ?? false;
  if (!archived) {
    where.push("archived_at IS NULL");
  }
  if (q.sessionId !== undefined) {
    where.push("session_id = ?");
    params.push(q.sessionId);
  }
  if (q.olderThanDays !== undefined && q.olderThanDays >= 0) {
    where.push(
      "created_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)",
    );
    params.push(`-${q.olderThanDays} days`);
  }
  const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  return {
    sql: `SELECT * FROM artifacts ${whereClause} ORDER BY created_at ASC, id ASC`,
    params,
  };
};

export const ArtifactRepoLive: Layer.Layer<ArtifactRepo, never, DbConnection> = Layer.effect(
  ArtifactRepo,
  Effect.gen(function* () {
    const conn = yield* DbConnection;
    return {
      listArtifacts: (q) =>
        trySync(() => {
          const { sql, params } = buildListSql(q);
          return conn.handle.all<ArtifactRow>(sql, params);
        }, (e) => new DbError({ message: "listArtifacts", cause: e })),

      markArtifactArchived: (id, archivedAt) =>
        trySync(
          () =>
            conn.handle.run(
              `UPDATE artifacts SET archived_at = ? WHERE id = ? AND archived_at IS NULL`,
              [archivedAt, id],
            ).changes,
          (e) => new DbError({ message: "markArtifactArchived", cause: e }),
        ),

      deleteArtifact: (id) =>
        trySync(
          () => conn.handle.run(`DELETE FROM artifacts WHERE id = ?`, [id]).changes,
          (e) => new DbError({ message: "deleteArtifact", cause: e }),
        ),
    };
  }),
);
