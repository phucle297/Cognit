import { Context, Layer } from "effect";
import { Redactor } from "./context";
import { BUILT_IN_REDACTION_PATTERNS, type BuiltInRedactionPattern } from "@cognit/core/redaction";

/**
 * A redaction hit. Never carries the redacted content — only the
 * pattern name and a path to the field, so audit events can be
 * reconstructed without leaking secrets.
 */
export interface RedactionHit {
  readonly pattern: string;
  readonly fieldPath: string;
}

type RedactorService = Context.Tag.Service<typeof Redactor>;

/**
 * Default live Redactor: applies built-in patterns (always on).
 * User-supplied patterns from cognit.yaml are passed in at construction
 * and merged on top.
 */
export const makeRedactor = (
  userPatterns: ReadonlyArray<BuiltInRedactionPattern> = [],
): RedactorService => {
  const patterns: ReadonlyArray<BuiltInRedactionPattern> = [
    ...BUILT_IN_REDACTION_PATTERNS,
    ...userPatterns,
  ];
  const compiled = patterns.map((p) => ({
    name: p.name,
    regex: new RegExp(p.regex, "g"),
    replacement: p.replacement,
  }));

  const scanString = (text: string): RedactionHit[] => {
    const hits: RedactionHit[] = [];
    for (const c of compiled) {
      c.regex.lastIndex = 0;
      if (c.regex.test(text)) hits.push({ pattern: c.name, fieldPath: "" });
    }
    return hits;
  };

  const redactString = (text: string): string => {
    let out = text;
    for (const c of compiled) {
      c.regex.lastIndex = 0;
      out = out.replace(c.regex, c.replacement);
    }
    return out;
  };

  const scanValue = (value: unknown, path = ""): RedactionHit[] => {
    if (typeof value === "string") {
      const hits = scanString(value);
      return hits.map((h) => ({ pattern: h.pattern, fieldPath: path }));
    }
    if (Array.isArray(value)) {
      return value.flatMap((v, i) => scanValue(v, `${path}[${i}]`));
    }
    if (value !== null && typeof value === "object") {
      return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
        scanValue(v, path ? `${path}.${k}` : k),
      );
    }
    return [];
  };

  const redactValue = <T>(value: T): T => {
    if (typeof value === "string") return redactString(value) as unknown as T;
    if (Array.isArray(value)) return value.map((v) => redactValue(v)) as unknown as T;
    if (value !== null && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = redactValue(v);
      }
      return out as unknown as T;
    }
    return value;
  };

  return {
    scan: (text) => scanString(text),
    scanValue,
    redact: (text) => redactString(text),
    redactValue,
  };
};

export const RedactorLive: Layer.Layer<Redactor> = Layer.succeed(Redactor)(makeRedactor());

/** Test layer: empty pattern set (no false positives in unit tests). */
export const RedactorNoop: Layer.Layer<Redactor> = Layer.succeed(Redactor, makeRedactor([]));

/**
 * Apply redaction in-memory to payload + source before insert.
 * Returns the redacted pair and a list of hits.
 */
export const redactEvent = (
  payload: unknown,
  source: unknown,
  redactor: RedactorService,
): { redactedPayload: unknown; redactedSource: unknown; hits: ReadonlyArray<RedactionHit> } => {
  // Wrap in envelope so scanValue can attribute every hit to a non-empty path
  // (e.g. "payload.text", "source.command", "payload[0]"). This is needed because
  // scanValue's string branch sets fieldPath to the path argument, which would
  // be "" if we passed the raw string.
  //
  // NOTE: redactValue still operates on the raw payload/source so that
  // payload_json's shape stays unchanged.
  const payloadHits = redactor.scanValue({ value: payload }, "payload");
  const sourceHits = source === undefined ? [] : redactor.scanValue({ value: source }, "source");
  return {
    redactedPayload: redactor.redactValue(payload),
    redactedSource: source === undefined ? undefined : redactor.redactValue(source),
    hits: [...payloadHits, ...sourceHits],
  };
};
