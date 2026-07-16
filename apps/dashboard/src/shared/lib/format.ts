/**
 * apps/dashboard/src/shared/lib/format.ts — display formatters.
 *
 * FSD layer: shared. ULIDs and ISO timestamps surface in the API
 * surface and must render predictably. Keep this dependency-free.
 */

const ULID_LENGTH = 26;
const ULID_ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * Render a ULID as `<first 8>…<last 4>` for compact display.
 * Returns the input unchanged when it does not look like a ULID,
 * so the formatter is safe on raw ids from arbitrary rows.
 */
export const formatUlid = (id: string | null | undefined): string => {
  if (!id) return "—";
  if (id.length !== ULID_LENGTH) return id;
  return `${id.slice(0, 8)}…${id.slice(-4)}`;
};

/**
 * Format an ISO-8601 timestamp as `<YYYY-MM-DD HH:MM:SS>Z` in UTC.
 * Falls back to the input string when parsing fails.
 */
export const formatIso = (iso: string | null | undefined): string => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number): string => n.toString().padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}Z`
  );
};

/** D-M5-00: raw event type → semantic family badge label. */
const EVENT_FAMILY_LABELS: Readonly<Record<string, string>> = {
  observation_recorded: "Observe",
  action_recorded: "Action",
  verification_started: "Verify",
  verification_passed: "Verify",
  verification_failed: "Verify",
  verification_errored: "Verify",
  verification_cancelled: "Verify",
  verification_rerun: "Verify",
  decision_proposed: "Decide",
  decision_accepted: "Decide",
  decision_rejected: "Decide",
  decision_superseded: "Decide",
  conclusion_proposed: "Conclude",
  conclusion_verified: "Conclude",
  conclusion_rejected: "Conclude",
  hypothesis_created: "Hypothesis",
  hypothesis_weakened: "Hypothesis",
  hypothesis_rejected: "Hypothesis",
  hypothesis_promoted: "Hypothesis",
  hypothesis_ranked: "Hypothesis",
  actor_registered: "System",
  session_created: "System",
  snapshot_created: "System",
  project_created: "System",
};

/**
 * Map a raw event `type`/`kind` to a short semantic family label
 * (Observe / Action / Verify / …). Unknown types become Title Case
 * of the snake_case name.
 */
export const eventFamilyLabel = (kind: string | null | undefined): string => {
  if (!kind) return "—";
  const mapped = EVENT_FAMILY_LABELS[kind];
  if (mapped) return mapped;
  return kind
    .split("_")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
};

/**
 * Human label for `action_kind` (`applied_fix` → "Applied fix").
 * Sentence-style: first word capitalised, rest lower.
 */
export const formatActionKindLabel = (kind: string): string => {
  const parts = kind.split("_").filter(Boolean);
  if (parts.length === 0) return kind;
  return parts
    .map((w, i) =>
      i === 0
        ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
        : w.toLowerCase(),
    )
    .join(" ");
};

/**
 * Summarise an event payload (object) for the Timeline row.
 *
 * Prefer:
 * - `action_kind` + optional `text` → "Applied fix: …"
 * - `text` alone → "text: …"
 * - otherwise first scalar field after `kind`/`id`.
 */
export const formatPayloadSummary = (payload: unknown): string => {
  if (payload === null || payload === undefined) return "";
  if (typeof payload === "string") return payload;
  if (typeof payload !== "object") return String(payload);
  const obj = payload as Record<string, unknown>;

  const actionKind = typeof obj.action_kind === "string" ? obj.action_kind : null;
  const text = typeof obj.text === "string" ? obj.text : null;
  if (actionKind) {
    const label = formatActionKindLabel(actionKind);
    if (text && text.length > 0) return `${label}: ${text}`;
    return label;
  }
  if (text && text.length > 0) {
    return `text: ${text}`;
  }

  const keys = Object.keys(obj);
  const summaryKey = keys.find((k) => k !== "kind" && k !== "id");
  if (!summaryKey) return JSON.stringify(payload).slice(0, 80);
  const value = obj[summaryKey];
  if (typeof value === "string") return `${summaryKey}: ${value}`;
  if (typeof value === "number" || typeof value === "boolean") {
    return `${summaryKey}: ${value}`;
  }
  return `${summaryKey}: ${JSON.stringify(value).slice(0, 60)}`;
};

/**
 * Sanity check for whether a string is a 26-char Crockford base32
 * ULID. Exposed so the rest of the app can decide whether to
 * format-or-pass-through.
 */
export const isUlid = (s: string): boolean => {
  if (s.length !== ULID_LENGTH) return false;
  for (let i = 0; i < ULID_LENGTH; i++) {
    if (!ULID_ENCODING.includes(s[i]!)) return false;
  }
  return true;
};
