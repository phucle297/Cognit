/**
 * apps/dashboard/src/components/NewSessionDialog.tsx
 *
 * Create a session via POST /api/sessions { goal, actor }.
 * Bound to the Cognit root the API was started with (cwd / --root).
 */
import { useState, type FormEvent, type JSX } from "react";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { Input } from "@/shared/ui/input";
import { apiFetch, ApiError } from "@/shared/api/api-client";

export type NewSessionDialogProps = {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onCreated: (sessionId: string) => void;
};

type CreatedSession = {
  readonly session: { readonly id: string };
};

export const NewSessionDialog = ({
  open,
  onOpenChange,
  onCreated,
}: NewSessionDialogProps): JSX.Element => {
  const [goal, setGoal] = useState<string>("");
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const reset = (): void => {
    setGoal("");
    setError(null);
  };

  const onSubmit = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    if (submitting) return;
    const trimmed = goal.trim();
    if (trimmed.length === 0) {
      setError("goal is required");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const data = await apiFetch<CreatedSession>("/api/sessions", {
        method: "POST",
        body: {
          goal: trimmed,
          actor: { name: "dashboard", type: "human" },
        },
      });
      const id = data.session.id;
      reset();
      onOpenChange(false);
      onCreated(id);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.api.message);
      } else {
        setError(err instanceof Error ? err.message : "unknown error");
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New session</DialogTitle>
          <DialogDescription>
            Start a reasoning session in this Cognit root. Sessions store observations,
            decisions, and evidence.
          </DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-3" onSubmit={onSubmit}>
          <label className="text-sm font-medium" htmlFor="new-session-goal">
            Goal
          </label>
          <Input
            id="new-session-goal"
            name="goal"
            autoFocus
            required
            minLength={1}
            maxLength={500}
            placeholder="What are you trying to figure out?"
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            disabled={submitting}
            data-testid="new-session-goal-input"
          />
          {error ? (
            <p className="text-sm text-destructive" data-testid="new-session-error">
              {error}
            </p>
          ) : null}
          <DialogFooter className="mt-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={submitting || goal.trim().length === 0}
              data-testid="new-session-submit"
            >
              {submitting ? "Creating…" : "Create session"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};
