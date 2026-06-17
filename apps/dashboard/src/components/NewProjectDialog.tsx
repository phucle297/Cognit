/**
 * apps/dashboard/src/components/NewProjectDialog.tsx — Radix dialog
 * to create a new project. Submits `{ name, goal? }` to /projects
 * via apiFetch, surfaces ApiError, and invokes `onCreated` on
 * success so the parent can refetch + close.
 *
 * FSD layer: components (composable leaf above shared/ui).
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

export type NewProjectDialogProps = {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onCreated: () => void;
};

export const NewProjectDialog = ({
  open,
  onOpenChange,
  onCreated,
}: NewProjectDialogProps): JSX.Element => {
  const [name, setName] = useState<string>("");
  const [goal, setGoal] = useState<string>("");
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const reset = (): void => {
    setName("");
    setGoal("");
    setError(null);
  };

  const onSubmit = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    if (submitting) return;
    const trimmedName = name.trim();
    if (trimmedName.length === 0) {
      setError("name is required");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await apiFetch<unknown>("/projects", {
        method: "POST",
        body: { name: trimmedName, goal: goal.trim() || undefined },
      });
      reset();
      onCreated();
      onOpenChange(false);
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
          <DialogTitle>New project</DialogTitle>
          <DialogDescription>
            Create a project to group sessions and events. Name must be 1–120 characters.
          </DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-3" onSubmit={onSubmit}>
          <label className="text-sm font-medium" htmlFor="new-project-name">
            Name
          </label>
          <Input
            id="new-project-name"
            name="name"
            autoFocus
            required
            minLength={1}
            maxLength={120}
            placeholder="my-project"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={submitting}
          />
          <label className="text-sm font-medium" htmlFor="new-project-goal">
            Goal (optional)
          </label>
          <Input
            id="new-project-goal"
            name="goal"
            placeholder="What are you trying to learn?"
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            disabled={submitting}
          />
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          <DialogFooter className="mt-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={submitting || name.trim().length === 0}>
              {submitting ? "Creating…" : "Create project"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};
