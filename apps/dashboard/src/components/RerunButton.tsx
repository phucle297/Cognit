/**
 * apps/dashboard/src/components/RerunButton.tsx
 *
 * FSD layer: components. Reruns a verification by POSTing a fresh
 * `verification_started` event to `/verify`. The new event becomes
 * a new Verification row; existing UI uses `apiFetch` directly so
 * the caller (VerificationList) can decide how to react (refetch
 * the session state, optimistically append, etc.).
 *
 * Body shape matches `apps/server/src/routes/verify.ts` POST /verify:
 *   {
 *     session_id, command, type,
 *     actor: { name, type },
 *     linked_hypothesis_id?, timeout_ms?, correlation_id?
 *   }
 */
import { useState, type JSX } from "react";
import { apiFetch } from "@/lib/api-client";
import { Button } from "@/shared/ui/button";

export type VerificationKind = "test" | "lint" | "build" | "exec" | "typecheck";
export type ActorLike = { name: string; type: "human" | "worker" | "system" };

export type RerunButtonProps = {
  readonly sessionId: string;
  readonly command: string;
  readonly type: VerificationKind;
  readonly actor: ActorLike;
  readonly linkedHypothesisId?: string | null;
  readonly onRerun?: ((verificationId: string) => void) | undefined;
};

export const RerunButton = ({
  sessionId,
  command,
  type,
  actor,
  linkedHypothesisId,
  onRerun,
}: RerunButtonProps): JSX.Element => {
  const [busy, setBusy] = useState<boolean>(false);

  const onClick = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      const body: Record<string, unknown> = {
        session_id: sessionId,
        command,
        type,
        actor,
      };
      if (linkedHypothesisId) body["linked_hypothesis_id"] = linkedHypothesisId;
      const resp = await apiFetch<{ id: string }>("/verify", {
        method: "POST",
        body,
      });
      if (onRerun) onRerun(resp.id);
    } catch {
      // Surface the failure via console — the parent page is
      // responsible for refetching state. A future revision can
      // route this through a toast/notification primitive.
      // eslint-disable-next-line no-console
      console.error("RerunButton: POST /verify failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      data-testid="rerun-button"
      disabled={busy}
      onClick={onClick}
      aria-label="Rerun verification"
    >
      {busy ? "Rerunning…" : "Rerun"}
    </Button>
  );
};