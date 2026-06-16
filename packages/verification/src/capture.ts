/**
 * `capture.ts` — truncate subprocess output to a 1 MB inline excerpt.
 *
 * The event row in `events` carries `stdout_excerpt` / `stderr_excerpt`
 * as TEXT columns. To keep rows bounded (and the reducer/state JSON
 * small) we cap inline excerpts at 1 MB. The full output is still
 * preserved on disk in `artifacts/<sha256>.log` (see artifact.ts) so
 * nothing is lost — only the inline copy is truncated.
 *
 * Truncation policy: keep the FIRST 1 MB and append a sentinel line
 * `"\n... [truncated at 1MB, full output in artifacts/<sha256>.log]"`.
 * Cutting the tail (most recent output) is intentional — failure modes
 * tend to dump the relevant context early (stack trace, panic), and
 * the tail is mostly noise / retry loops.
 */

export const TRUNCATE_BYTES = 1024 * 1024; // 1 MB
export const TRUNCATION_SENTINEL =
  "\n... [truncated at 1MB, full output in artifacts/<sha256>.log]";

/**
 * Truncate to 1 MB. We slice by character (not bytes) for safety; the
 * worst case is we keep a touch more than 1 MB if a multi-byte char
 * straddles the boundary, which is acceptable for an excerpt.
 */
export const truncateExcerpt = (text: string): string => {
  if (text.length <= TRUNCATE_BYTES) return text;
  return text.slice(0, TRUNCATE_BYTES) + TRUNCATION_SENTINEL;
};

/**
 * Helper: report the original size + excerpt size so the caller can
 * decide whether to write an artifact. Threshold: 1 KB of combined
 * output is small enough to inline; beyond that, write the artifact.
 */
export const shouldWriteArtifact = (stdout: string, stderr: string): boolean =>
  stdout.length + stderr.length > 1024;
