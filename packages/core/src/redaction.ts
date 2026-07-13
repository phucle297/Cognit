/**
 * Built-in redaction patterns. Always applied at event ingest (Phase 1
 * `appendEvent`) regardless of user config. Users may add more in
 * `cognit.yaml` under `redaction.patterns`.
 *
 * The matchers operate on string JSON values. The full pipeline lives
 * in `packages/db/redaction.ts` (Phase 1).
 */

export interface BuiltInRedactionPattern {
  readonly name: string;
  readonly regex: string;
  readonly replacement: string;
}

export const BUILT_IN_REDACTION_PATTERNS: readonly BuiltInRedactionPattern[] = [
  {
    name: "jwt",
    regex: "eyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+",
    replacement: "[REDACTED:jwt]",
  },
  {
    name: "api_key_inline",
    regex: "(api[_-]?key|secret|token)[\"']?\\s*[:=]\\s*[\"']?([A-Za-z0-9_-]{16,})",
    replacement: "$1=[REDACTED:api_key]",
  },
  {
    name: "pem_block",
    regex: "-----BEGIN [A-Z ]+PRIVATE KEY-----[\\s\\S]*?-----END [A-Z ]+PRIVATE KEY-----",
    replacement: "[REDACTED:pem_block]",
  },
  {
    name: "password_field",
    regex: "(password|passwd|pwd)[\"']?\\s*[:=]\\s*[\"']?([^\\s\"',}{]+)",
    replacement: "$1=[REDACTED:password]",
  },
  // High-value provider tokens (D-M1-04). Anchored with prefix +
  // length floors to keep false positives low.
  {
    name: "openai_sk",
    regex: "\\bsk-[A-Za-z0-9]{20,}\\b",
    replacement: "[REDACTED:openai_sk]",
  },
  {
    name: "github_pat",
    regex: "\\b(ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\\b",
    replacement: "[REDACTED:github_pat]",
  },
];
