/**
 * Map wire EventRow (DB / API) → timeline EventRowShape.
 *
 * API returns raw SQLite rows:
 *   { id, type, created_at, payload_json, actor_id, session_id, ... }
 * UI expects:
 *   { id, kind, ts, payload, actor, session_id }
 */
import type { EventRowShape } from "@/components/EventRow";

export type WireEvent = {
  readonly id?: unknown;
  readonly kind?: unknown;
  readonly type?: unknown;
  readonly session_id?: unknown;
  readonly actor?: unknown;
  readonly actor_id?: unknown;
  readonly ts?: unknown;
  readonly created_at?: unknown;
  readonly payload?: unknown;
  readonly payload_json?: unknown;
};

const parsePayload = (raw: WireEvent): unknown => {
  if (raw.payload !== undefined) return raw.payload;
  const pj = raw.payload_json;
  if (typeof pj === "string" && pj.length > 0) {
    try {
      return JSON.parse(pj) as unknown;
    } catch {
      return pj;
    }
  }
  if (pj !== undefined && pj !== null) return pj;
  return null;
};

const actorFromWire = (raw: WireEvent, payload: unknown): string => {
  if (typeof raw.actor === "string" && raw.actor.length > 0) return raw.actor;
  if (payload && typeof payload === "object" && payload !== null) {
    const p = payload as Record<string, unknown>;
    if (typeof p.actor_name === "string" && p.actor_name.length > 0) return p.actor_name;
  }
  if (typeof raw.actor_id === "string" && raw.actor_id.length > 0) {
    // Fall back to short id prefix — better than empty.
    return raw.actor_id.slice(0, 10);
  }
  return "";
};

/** Normalize one wire event; returns null if unusable (no id). */
export const normalizeEvent = (raw: unknown): EventRowShape | null => {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as WireEvent;
  const id = typeof r.id === "string" ? r.id : "";
  if (id.length === 0) return null;
  const kind =
    typeof r.kind === "string" && r.kind.length > 0
      ? r.kind
      : typeof r.type === "string" && r.type.length > 0
        ? r.type
        : "unknown";
  const session_id = typeof r.session_id === "string" ? r.session_id : "";
  const ts =
    typeof r.ts === "string" && r.ts.length > 0
      ? r.ts
      : typeof r.created_at === "string"
        ? r.created_at
        : "";
  const payload = parsePayload(r);
  const actor = actorFromWire(r, payload);
  return { id, kind, session_id, actor, ts, payload };
};

export const normalizeEvents = (raw: unknown): ReadonlyArray<EventRowShape> => {
  if (!Array.isArray(raw)) return [];
  const out: EventRowShape[] = [];
  for (const item of raw) {
    const n = normalizeEvent(item);
    if (n) out.push(n);
  }
  return out;
};
