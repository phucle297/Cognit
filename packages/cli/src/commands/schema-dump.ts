/**
 * `cognit schema-dump` — print the stable JSON envelope shape as
 * TypeScript types so consumers can copy it into their client.
 *
 * Phase 3b introduces the v1 envelope. We hand-author the type
 * here rather than re-exporting from `output.ts` so the printed
 * copy is self-contained and pins the v1 contract.
 */

import { Command } from "commander";

const ENVELOPE_TS = `// Stable JSON envelope (v1) emitted by every \`cognit --json\`
// command. Pin this in your client; bump the version field if the
// shape ever changes.

export type OutputMode = "text" | "json";

export interface JsonEnvelopeV1<T = unknown> {
  readonly version: 1;
  readonly kind: string;
  readonly data: T;
}

// Example kinds emitted by current commands:
//   "session.list"      → data: SessionRow[]
//   "session.show"      → data: SessionShowResult
//   "session.create"    → data: { session: SessionRow }
//   "session.close"     → data: { session: SessionRow }
//   "session.resume"    → data: { session: SessionRow; parent: SessionRow; forked: boolean }
//   "observation.add"   → data: EventRow
//   "finding.add"       → data: EventRow
//   "hypothesis.add"    → data: EventRow
//   "hypothesis.weaken" → data: EventRow
//   "hypothesis.reject" → data: EventRow
//   "hypothesis.promote"→ data: EventRow
//   "theory.add"        → data: EventRow
//   "theory.update"     → data: EventRow
//   "theory.merge"      → data: EventRow
//   "theory.archive"    → data: EventRow
//   "experiment.add"    → data: EventRow
//   "experiment.complete" → data: EventRow
//   "decision.add"      → data: EventRow
//   "decision.accept"   → data: EventRow
//   "decision.reject"   → data: EventRow
//   "decision.supersede"→ data: EventRow
//   "conclusion.add"    → data: EventRow
//   "conclusion.verify" → data: EventRow
//   "conclusion.reject" → data: EventRow
//   "verify.start"      → data: EventRow
//   "verify.cancel"     → data: EventRow
//   "artifact.add"      → data: EventRow
//   "edge.add"          → data: EventRow
//   "edge.list"         → data: EdgeListRow[]
//   "append"            → data: EventRow
//   "inbox.process"     → data: { processed: string[]; errors: string[] }
`;

export function registerSchemaDump(program: Command): void {
  program
    .command("schema-dump")
    .description("print the v1 JSON envelope shape as TypeScript types")
    .action(() => {
      process.stdout.write(ENVELOPE_TS);
    });
}
