/**
 * apps/server/src/event-queries.ts — project-wide event reads.
 *
 * The DB EventStore.list requires a `sessionId`. For server use
 * cases (SSE replay, project-wide event feed) we need a query
 * that spans the whole project. Rather than expand the EventStore
 * surface for v1, we open the connection directly and run a
 * read-only query. This is a v1 convenience; phase 4 will add
 * `EventStore.listAcrossProject` (or similar) properly.
 */
import { Effect } from "effect";
import { DbConnection, type EventRow } from "@cognit/db";

/** Real implementation: use a generator that yields DbConnection. */
export const listRecentAcrossProjectE = (
  projectId: string,
  limit: number,
): Effect.Effect<ReadonlyArray<EventRow>, never, DbConnection> =>
  Effect.gen(function* () {
    const conn = yield* DbConnection;
    const rows = conn.handle.all<EventRow>(
      `SELECT * FROM events
       WHERE project_id = ?
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
      [projectId, limit],
    );
    // SSE expects ascending order for replay
    return rows.slice().reverse();
  });

/** Reverse-chronological list of the most recent N events for a session. */
export const listRecentForSessionE = (
  sessionId: string,
  limit: number,
): Effect.Effect<ReadonlyArray<EventRow>, never, DbConnection> =>
  Effect.gen(function* () {
    const conn = yield* DbConnection;
    const rows = conn.handle.all<EventRow>(
      `SELECT * FROM events
       WHERE session_id = ?
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
      [sessionId, limit],
    );
    return rows.slice().reverse();
  });

/**
 * Cursor-paginated replay: events for a project with `id > afterId`,
 * ordered ascending. Used by SSE when the client reconnects with a
 * `Last-Event-ID` header — replay everything since that id instead
 * of the last N. ULIDs sort lex-correctly so `>` is enough.
 */
export const listAfterEventAcrossProjectE = (
  projectId: string,
  afterId: string,
  limit: number,
): Effect.Effect<ReadonlyArray<EventRow>, never, DbConnection> =>
  Effect.gen(function* () {
    const conn = yield* DbConnection;
    const rows = conn.handle.all<EventRow>(
      `SELECT * FROM events
       WHERE project_id = ? AND id > ?
       ORDER BY id ASC
       LIMIT ?`,
      [projectId, afterId, limit],
    );
    return rows;
  });
