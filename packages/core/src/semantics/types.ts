/**
 * Shared types for the semantic pipeline (D-M5-00).
 */
import type { ActionKind } from "./action-kinds.js";
import type { ArtifactRole, VerificationKind } from "../state.js";

/** Host-agnostic tool signal after Normalizer. */
export interface NormalizedToolSignal {
  readonly phase: "pre" | "post" | "failure";
  readonly host: string;
  /** Canonical tool id for rules (write | search_replace | read_file | shell | grep | …). */
  readonly tool: string;
  readonly rawToolName: string;
  readonly path: string | null;
  readonly command: string | null;
  readonly text: string;
  readonly toolInput: unknown;
  readonly toolResponse: unknown | null;
  readonly exitCode: number | null;
  readonly ok: boolean | null;
}

export interface SessionContext {
  readonly goal?: string | null;
  readonly current_hypothesis_id?: string | null;
  readonly recent_event_types?: ReadonlyArray<string>;
}

export interface ClassifierInput {
  readonly signal: NormalizedToolSignal;
  readonly sessionContext?: SessionContext;
}

export type SemanticClass =
  | { readonly family: "ignore"; readonly reason: string; readonly confidence: number }
  | {
      readonly family: "observation";
      readonly text: string;
      readonly confidence: number;
    }
  | {
      readonly family: "action";
      readonly text: string;
      readonly action_kind: ActionKind;
      readonly confidence: number;
    }
  | {
      readonly family: "verification";
      readonly phase: "start" | "outcome";
      readonly kind: VerificationKind;
      readonly command: string;
      readonly exit_code?: number | null;
      readonly confidence: number;
    }
  | { readonly family: "decision"; readonly text: string; readonly confidence: number }
  | { readonly family: "conclusion"; readonly text: string; readonly confidence: number }
  | {
      readonly family: "artifact";
      readonly role: ArtifactRole;
      readonly path: string;
      readonly confidence: number;
    }
  | {
      readonly family: "hypothesis";
      readonly title: string;
      readonly text: string;
      readonly confidence: number;
    };

/** Domain event ready for SessionService.appendEvent (producer output). */
export interface ProducedEvent {
  readonly type: string;
  readonly payload: Record<string, unknown>;
  readonly confidence?: number;
  readonly linked_hypothesis_id?: string | null;
}
