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

/**
 * Summarise an event payload (object) for the Timeline row.
 * Picks the first scalar field after `kind` and renders
 * `key: value`; otherwise returns a short JSON preview.
 */
export const formatPayloadSummary = (payload: unknown): string => {
  if (payload === null || payload === undefined) return "";
  if (typeof payload === "string") return payload;
  if (typeof payload !== "object") return String(payload);
  const obj = payload as Record<string, unknown>;
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
