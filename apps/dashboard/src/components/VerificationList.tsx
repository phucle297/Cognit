/**
 * apps/dashboard/src/components/VerificationList.tsx
 *
 * FSD layer: components. Renders the verifications belonging to a
 * single `linked_hypothesis_id` group. Each row exposes:
 *  - status badge
 *  - command preview
 *  - type chip (test / lint / build / exec / typecheck)
 *  - `RerunButton` — POST /verify
 *  - `CancelButton` — POST /verify/:id/cancel, disabled when terminal
 *
 * Caller passes the session id and actor for the action bodies;
 * the list itself is presentational.
 */
import type { JSX } from "react";
import { Badge } from "@/shared/ui/badge";
import { CancelButton, type VerificationLifecycleForButton } from "./CancelButton";
import { RerunButton, type ActorLike, type VerificationKind } from "./RerunButton";

export type VerificationListItem = {
  readonly id: string;
  readonly command: string;
  readonly type: VerificationKind;
  readonly linked_hypothesis_id: string | null;
  readonly state: VerificationLifecycleForButton;
};

export type VerificationListProps = {
  readonly verifications: ReadonlyArray<VerificationListItem>;
  readonly sessionId: string;
  readonly actor: ActorLike;
  readonly onRerun?: (verificationId: string) => void;
  readonly onCancel?: (id: string) => void;
};

export const VerificationList = ({
  verifications,
  sessionId,
  actor,
  onRerun,
  onCancel,
}: VerificationListProps): JSX.Element => {
  if (verifications.length === 0) {
    return (
      <div
        data-testid="verification-empty"
        className="px-3 py-6 text-center text-sm text-muted-foreground"
      >
        No verifications for this hypothesis yet.
      </div>
    );
  }
  return (
    <div
      data-testid="verification-list"
      role="list"
      className="overflow-hidden rounded-md border border-divider bg-card shadow-[var(--shadow-sm)]"
    >
      {verifications.map((v, idx) => (
        <div
          role="listitem"
          key={v.id}
          data-testid="verification-row"
          data-verification-id={v.id}
          data-verification-status={v.state}
          style={{ "--stagger-index": idx } as React.CSSProperties}
          className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-divider px-3 py-2 text-sm last:border-b-0 stagger-item"
        >
          <div className="flex min-w-0 flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline" data-testid="verification-status">
                {v.state}
              </Badge>
              <Badge variant="secondary">{v.type}</Badge>
            </div>
            <code
              data-testid="verification-command"
              className="truncate font-mono text-xs text-muted-foreground"
            >
              {v.command}
            </code>
          </div>
          <div className="flex items-center gap-2">
            <RerunButton
              sessionId={sessionId}
              command={v.command}
              type={v.type}
              actor={actor}
              linkedHypothesisId={v.linked_hypothesis_id}
              onRerun={onRerun}
            />
            <CancelButton
              verificationId={v.id}
              status={v.state}
              actor={actor}
              onCancel={onCancel}
            />
          </div>
        </div>
      ))}
    </div>
  );
};