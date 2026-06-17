/**
 * apps/dashboard/src/shared/api/use-event-source.ts — SSE hook.
 *
 * FSD layer: shared. Wraps the native `EventSource` (no
 * polyfill). Reconnect is browser-driven; we read `id:` from
 * the previous event and pass it as `Last-Event-ID` on the
 * retry URL by setting `eventSource.url` is not writable, so we
 * recreate the connection with `?last_event_id=…` instead.
 *
 * Backoff: the browser handles reconnection, but we cap the
 * visible "reconnect delay" status at 30 seconds for the UI.
 */
import { useEffect, useRef, useState } from "react";

export type SseStatus = "connecting" | "open" | "closed";

export type SseEvent<T> = {
  id: string;
  event: string;
  data: T;
};

export type UseEventSourceState<T> = {
  events: ReadonlyArray<SseEvent<T>>;
  status: SseStatus;
  close: () => void;
};

const MAX_BACKOFF_MS = 30_000;

export const useEventSource = <T = unknown>(url: string | null): UseEventSourceState<T> => {
  const [events, setEvents] = useState<ReadonlyArray<SseEvent<T>>>([]);
  const [status, setStatus] = useState<SseStatus>(url === null ? "closed" : "connecting");
  const sourceRef = useRef<EventSource | null>(null);
  const lastIdRef = useRef<string | null>(null);
  const attemptRef = useRef<number>(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const manualCloseRef = useRef<boolean>(false);

  useEffect(() => {
    manualCloseRef.current = false;
    if (url === null) {
      setStatus("closed");
      return;
    }

    const open = (): void => {
      // Append `last_event_id` as a query param so the server can
      // resume from the last received event. The native API does
      // not expose a way to set Last-Event-ID on a fresh
      // EventSource, so we use a query-string fallback.
      const u = lastIdRef.current
        ? `${url}${url.includes("?") ? "&" : "?"}last_event_id=${encodeURIComponent(lastIdRef.current)}`
        : url;
      const es = new EventSource(u, { withCredentials: true });
      sourceRef.current = es;
      setStatus("connecting");

      es.onopen = (): void => {
        attemptRef.current = 0;
        setStatus("open");
      };
      es.onmessage = (ev: MessageEvent<string>): void => {
        const id = ev.lastEventId || "";
        if (id) lastIdRef.current = id;
        let data: T;
        try {
          data = JSON.parse(ev.data) as T;
        } catch {
          // Treat raw text as the data payload.
          data = ev.data as unknown as T;
        }
        setEvents((prev) => [...prev, { id, event: ev.type || "message", data }]);
      };
      es.onerror = (): void => {
        if (manualCloseRef.current) return;
        // The native EventSource is in a "reconnecting" state.
        // We surface a closed status briefly, then transition
        // back to connecting on the next onopen.
        setStatus("closed");
        const delay = Math.min(2 ** attemptRef.current * 250, MAX_BACKOFF_MS);
        attemptRef.current += 1;
        if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = setTimeout(() => {
          if (manualCloseRef.current) return;
          es.close();
          open();
        }, delay);
      };
    };

    open();

    return () => {
      manualCloseRef.current = true;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (sourceRef.current) {
        sourceRef.current.close();
        sourceRef.current = null;
      }
      setStatus("closed");
    };
  }, [url]);

  const close = (): void => {
    manualCloseRef.current = true;
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (sourceRef.current) {
      sourceRef.current.close();
      sourceRef.current = null;
    }
    setStatus("closed");
  };

  return { events, status, close };
};
