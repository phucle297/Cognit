/**
 * apps/dashboard/src/components/CancelButton.tsx
 *
 * FSD layer: components. Cancels an in-flight verification by
 * POSTing to `/verify/:id/cancel`. Disabled when the verification
 * status is terminal — `passed`, `failed`, `errored`, or
 * `cancelled` (matches the server's TERMINAL_TYPES in
 * apps/server/src/routes/verify.ts).
 *
 * The verification lifecycle is the source of truth: started →
 * terminal. The server is idempotent on terminal, but the UI
 * surfaces the read-only state by disabling the button.
 */
import { useState, type JSX } from "react";
import { apiFetch } from "@/lib/api-client";
import { Button } from "@/shared/ui/button";
import type { ActorLike } from "./RerunButton";

export type VerificationLifecycleForButton =
  | "started"
  | "passed"
  | "failed"
  | "errored"
  | "cancelled";

const TERMINAL_STATUSES: ReadonlySet<VerificationLifecycleForButton> = new Set([
  "passed",
  "failed",
  "errored",
  "cancelled",
]);

export const isTerminalStatus = (s: VerificationLifecycleForButton): boolean =>
  TERMINAL_STATUSES.has(s);

export type CancelButtonProps = {
  readonly verificationId: string;
  readonly status: VerificationLifecycleForButton;
  readonly actor: ActorLike;
  readonly reason?: string | undefined;
  readonly onCancel?: ((id: string) => void) | undefined;
};

export const CancelButton = ({
  verificationId,
  status,
  actor,
  reason,
  onCancel,
}: CancelButtonProps): JSX.Element => {
  const [busy, setBusy] = useState<boolean>(false);
  const disabled = busy || isTerminalStatus(status);

  const onClick = async (): Promise<void> => {
    if (disabled) return;
    setBusy(true);
    try {
      await apiFetch(`/verify/${verificationId}/cancel`, {
        method: "POST",
        body: { actor, reason: reason ?? "user_cancelled" },
      });
      if (onCancel) onCancel(verificationId);
    } catch {
      // eslint-disable-next-line no-console
      console.error("CancelButton: POST /verify/:id/cancel failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      data-testid="cancel-button"
      disabled={disabled}
      onClick={onClick}
      aria-label="Cancel verification"
    >
      {busy ? "Cancelling…" : "Cancel"}
    </Button>
  );
};