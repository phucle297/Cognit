/**
 * apps/dashboard/src/components/ProjectCard.tsx — single project tile.
 *
 * Renders project name, optional goal, and up to 5 most recent
 * sessions. The whole card is clickable and navigates to the
 * timeline. Used by the Overview page (6.2).
 */
import type { JSX } from "react";
import { useNavigate } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/shared/ui/card";

export type ProjectCardSession = {
  readonly id: string;
  readonly goal: string;
  readonly status: "active" | "paused" | "closed";
  readonly created_at: string;
};

export type ProjectCardProps = {
  readonly project: { readonly id: string; readonly name: string; readonly goal?: string };
  readonly sessions: ReadonlyArray<ProjectCardSession>;
};

export const ProjectCard = ({ project, sessions }: ProjectCardProps): JSX.Element => {
  const navigate = useNavigate();
  const recent = sessions.slice(0, 5);
  const firstId = recent[0]?.id;

  const onClick = (): void => {
    if (firstId) {
      navigate(`/timeline?session=${firstId}`);
    } else {
      navigate("/timeline");
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onClick();
    }
  };

  return (
    <Card
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={onKeyDown}
      className="cursor-pointer transition-colors hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      data-testid="project-card"
      data-project-id={project.id}
    >
      <CardHeader>
        <CardTitle className="truncate">{project.name}</CardTitle>
        {project.goal ? (
          <p className="text-sm text-muted-foreground line-clamp-2">{project.goal}</p>
        ) : null}
      </CardHeader>
      <CardContent>
        {recent.length === 0 ? (
          <p className="text-xs text-muted-foreground">No sessions yet.</p>
        ) : (
          <ul className="space-y-1.5 text-sm">
            {recent.map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-2">
                <span className="truncate" title={s.goal}>
                  {s.goal}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">{s.status}</span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
};
