import { Context, Effect, Layer } from "effect";
import { RedactionConfig, Redactor } from "./context";
import { BUILT_IN_REDACTION_PATTERNS, type BuiltInRedactionPattern } from "@cognit/core/redaction";

/**
 * A redaction hit. Never carries the redacted content itself — only the
 * pattern name, the original `match` text, the `[start, end)` span, and a
 * path to the field. The `match` is included so dry-run tooling (e.g.
 * `cognit redaction test`) can show what *would* be replaced without
 * having to keep the original buffer around; audit events at the
 * event-store boundary should NOT persist `match` to disk (a future
 * tightening, but out of scope for Phase 4 / 6bz.4).
 */
export interface RedactionHit {
  readonly pattern: string;
  readonly fieldPath: string;
  readonly span: readonly [number, number];
  readonly match: string;
}

type RedactorService = Context.Tag.Service<typeof Redactor>;
type RedactionConfigService = Context.Tag.Service<typeof RedactionConfig>;

/**
 * Span-preserving redaction. Applies each pattern to the *original*
 * text and records the `(start, end)` span of every match before any
 * replacement runs. The returned `redacted` is the sequential
 * replacement result; `hits` is one entry per *match* (not per pattern
 * — a pattern that matches twice emits two hits).
 *
 * Pure: does not consult any context. Callers (e.g. the redaction
 * test CLI) compose it with whatever pattern set they want.
 */
export const redactWithSpans = (
  text: string,
  patterns: ReadonlyArray<BuiltInRedactionPattern>,
): { redacted: string; hits: ReadonlyArray<RedactionHit> } => {
  const compiled = patterns.map((p) => ({
    name: p.name,
    regex: new RegExp(p.regex, "g"),
    replacement: p.replacement,
  }));
  const hits: RedactionHit[] = [];
  for (const c of compiled) {
    c.regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = c.regex.exec(text)) !== null) {
      hits.push({
        pattern: c.name,
        fieldPath: "",
        span: [m.index, m.index + m[0].length],
        match: m[0],
      });
      // Empty match would loop forever — nudge the cursor by one.
      if (m[0].length === 0) c.regex.lastIndex += 1;
    }
  }
  let redacted = text;
  for (const c of compiled) {
    c.regex.lastIndex = 0;
    redacted = redacted.replace(c.regex, c.replacement);
  }
  return { redacted, hits };
};

/**
 * Default live Redactor: applies built-in patterns merged with the
 * `RedactionConfig`'s user patterns. The user patterns come from
 * `cognit.yaml` (`redaction.patterns`) and are plumbed in via the CLI /
 * server `buildAppLayer` chain. When no `RedactionConfig` is provided,
 * `RedactorLiveWithDefault` (below) supplies an empty default.
 *
 * User patterns are compiled eagerly at construction; an invalid regex
 * will throw a `SyntaxError` from the `RegExp` constructor, which the
 * CLI catches and reports as a clean config error.
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
      let m: RegExpExecArray | null;
      while ((m = c.regex.exec(text)) !== null) {
        hits.push({
          pattern: c.name,
          fieldPath: "",
          span: [m.index, m.index + m[0].length],
          match: m[0],
        });
        if (m[0].length === 0) c.regex.lastIndex += 1;
      }
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
      return hits.map((h) => ({
        pattern: h.pattern,
        fieldPath: path,
        span: h.span,
        match: h.match,
      }));
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

/**
 * Live Redactor that reads user patterns from a `RedactionConfig`
 * layer on the R channel. Callers that want user patterns from
 * `cognit.yaml` to take effect must provide a `RedactionConfig` layer
 * alongside `RedactorLive` (or use `RedactorLiveWithDefault` for the
 * built-ins-only case).
 */
export const RedactorLive: Layer.Layer<Redactor, never, RedactionConfig> = Layer.effect(
  Redactor,
  Effect.gen(function* () {
    const config: RedactionConfigService = yield* RedactionConfig;
    return makeRedactor(config.userPatterns);
  }),
);

/** Default RedactionConfig: empty user-pattern set. */
export const RedactionConfigDefault: Layer.Layer<RedactionConfig> = Layer.succeed(
  RedactionConfig,
)({ userPatterns: [] });

/**
 * Convenience: `RedactorLive` with the default (empty) redaction
 * config already provided. Use this in `DbLive`'s leafs and in tests
 * that don't want to wire a config. The `Redactor` output is kept in
 * the result.
 */
export const RedactorLiveWithDefault: Layer.Layer<Redactor> = Layer.provideMerge(
  RedactorLive,
  RedactionConfigDefault,
);

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
