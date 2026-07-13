/**
 * Deterministic SessionState serialization shared by golden replay
 * fixtures and the db snapshot writer.
 *
 * Map fields (`hypotheses`, `decisions`, …) become plain objects keyed
 * by entity id — `JSON.stringify` would otherwise drop Map contents.
 * Object keys are sorted at every nesting level so two equal states
 * produce byte-equal output.
 *
 * Timeline is intentionally optional on the wire: snapshot writers may
 * slim it to `[]` (D-M1-02). Golden compare strips timeline by default
 * so entity-level equality is stable under slim snapshots.
 */

import type { SessionState } from "./state.js";

/** Current on-disk snapshot envelope version (D-M1-03). */
export const SNAPSHOT_SCHEMA_VERSION = 1 as const;

/**
 * Deep-sort keys and convert Maps to plain objects. Pure, no I/O.
 */
export const sortKeysDeep = (v: unknown): unknown => {
  if (v instanceof Map) {
    const obj: Record<string, unknown> = {};
    for (const [k, val] of v.entries()) {
      obj[String(k)] = val;
    }
    return sortKeysDeep(obj);
  }
  if (Array.isArray(v)) return v.map(sortKeysDeep);
  if (v && typeof v === "object") {
    const obj = v as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) {
      sorted[k] = sortKeysDeep(obj[k]);
    }
    return sorted;
  }
  return v;
};

export interface SerializeSessionStateOptions {
  /**
   * When true (default false), force `timeline: []` before serialize.
   * Used by snapshot writers that do not want O(n) timeline bloat.
   */
  readonly slimTimeline?: boolean;
}

/**
 * Serialize a SessionState to a deterministic JSON string.
 */
export const serializeSessionState = (
  state: SessionState,
  options: SerializeSessionStateOptions = {},
): string => {
  const prepared: SessionState = options.slimTimeline
    ? { ...state, timeline: [] }
    : state;
  return JSON.stringify(sortKeysDeep(prepared));
};

/**
 * Entity-level view for golden compare: drop timeline (O(n) history)
 * and keep maps/arrays/pointers. Used by golden replay only.
 */
export const entityStateForCompare = (
  state: SessionState,
): Record<string, unknown> => {
  const { timeline: _timeline, ...rest } = state;
  return sortKeysDeep(rest) as Record<string, unknown>;
};

/**
 * Snapshot envelope written to `snapshots.state_json` (D-M1-03).
 */
export interface SnapshotEnvelope {
  readonly schema_version: number;
  readonly state: unknown;
}

export const wrapSnapshotEnvelope = (
  state: SessionState,
  options: SerializeSessionStateOptions = {},
): string => {
  const prepared: SessionState = options.slimTimeline
    ? { ...state, timeline: [] }
    : state;
  const envelope: SnapshotEnvelope = {
    schema_version: SNAPSHOT_SCHEMA_VERSION,
    state: sortKeysDeep(prepared),
  };
  return JSON.stringify(envelope);
};

/**
 * Parse snapshot `state_json`. Returns null when the version is
 * unsupported (caller should full-replay). Legacy bare SessionState
 * JSON (no envelope) is treated as schema_version 0 and accepted.
 */
export const parseSnapshotStateJson = (
  raw: string,
): { readonly schema_version: number; readonly state: Record<string, unknown> } | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const obj = parsed as Record<string, unknown>;

  // Versioned envelope
  if ("schema_version" in obj && "state" in obj) {
    const version = obj["schema_version"];
    if (typeof version !== "number" || !Number.isInteger(version)) {
      return null;
    }
    if (version > SNAPSHOT_SCHEMA_VERSION || version < 0) {
      return null;
    }
    const inner = obj["state"];
    if (!inner || typeof inner !== "object" || Array.isArray(inner)) {
      return null;
    }
    return {
      schema_version: version,
      state: inner as Record<string, unknown>,
    };
  }

  // Legacy bare SessionState (v0)
  return { schema_version: 0, state: obj };
};
