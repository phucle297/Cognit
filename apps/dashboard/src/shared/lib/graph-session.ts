/**
 * apps/dashboard/src/shared/lib/graph-session.ts — last graph session.
 *
 * Graph nav often omits ?session=. We remember the last session the
 * user opened on the graph so the page is not permanently empty.
 */

export const GRAPH_LAST_SESSION_KEY = "cognit.graph.lastSession";

export const readLastGraphSession = (): string | null => {
  if (typeof window === "undefined") return null;
  try {
    const v = window.localStorage.getItem(GRAPH_LAST_SESSION_KEY);
    return v && v.length > 0 ? v : null;
  } catch {
    return null;
  }
};

export const writeLastGraphSession = (sessionId: string): void => {
  if (typeof window === "undefined") return;
  if (!sessionId) return;
  try {
    window.localStorage.setItem(GRAPH_LAST_SESSION_KEY, sessionId);
  } catch {
    // ignore quota / privacy mode
  }
};

/**
 * Resolve session for the graph page:
 *   URL ?session=  →  last stored  →  empty
 */
export const resolveGraphSession = (urlSession: string | null): string => {
  if (urlSession && urlSession.length > 0) return urlSession;
  return readLastGraphSession() ?? "";
};
