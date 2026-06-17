/**
 * apps/dashboard/src/pages/overview.tsx — 6.2 Overview page.
 *
 * Lists projects (GET /projects) with their most recent sessions
 * (GET /sessions, filtered client-side per project). Clicking a
 * project card jumps to /timeline?session=<first>. The "New
 * project" button opens a Radix dialog that POSTs to /projects
 * and refetches on success.
 *
 * Local types only — the response shapes are derived directly
 * from `apps/server/src/routes/projects.ts` and
 * `apps/server/src/routes/sessions.ts`.
 */
import { useMemo, useState, type JSX } from "react";
import { Button } from "@/shared/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/shared/ui/card";
import { useApi } from "@/lib/use-api";
import { ProjectCard, type ProjectCardSession } from "../components/ProjectCard";
import { NewProjectDialog } from "../components/NewProjectDialog";

type Project = {
  readonly id: string;
  readonly name: string;
  readonly goal?: string;
};

type ProjectsResp = {
  readonly projects: ReadonlyArray<Project>;
};

type Session = {
  readonly id: string;
  readonly project_id: string;
  readonly goal: string;
  readonly status: "active" | "paused" | "closed";
  readonly created_at: string;
};

type SessionsResp = {
  readonly sessions: ReadonlyArray<Session>;
};

export const OverviewPage = (): JSX.Element => {
  const projects = useApi<ProjectsResp>("/projects");
  const sessions = useApi<SessionsResp>("/sessions");
  const [dialogOpen, setDialogOpen] = useState<boolean>(false);

  const sessionsByProject = useMemo<Map<string, ProjectCardSession[]>>(() => {
    const m = new Map<string, ProjectCardSession[]>();
    for (const s of sessions.data?.sessions ?? []) {
      const arr = m.get(s.project_id) ?? [];
      arr.push({
        id: s.id,
        goal: s.goal,
        status: s.status,
        created_at: s.created_at,
      });
      m.set(s.project_id, arr);
    }
    // Newest first.
    for (const arr of m.values()) {
      arr.sort((a, b) => b.created_at.localeCompare(a.created_at));
    }
    return m;
  }, [sessions.data]);

  const list = projects.data?.projects ?? [];
  const isLoading = projects.loading || sessions.loading;
  const hasError = projects.error || sessions.error;

  const onCreated = (): void => {
    projects.refetch();
  };

  return (
    <div className="flex flex-col gap-6">
      <header className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Overview</h1>
          <p className="text-sm text-muted-foreground">
            Projects, recent sessions, and entry points into the timeline.
          </p>
        </div>
        <Button onClick={() => setDialogOpen(true)}>+ New project</Button>
      </header>

      {isLoading ? (
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground">Loading projects…</p>
          </CardContent>
        </Card>
      ) : hasError ? (
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-destructive">
              {projects.error?.api.message ?? sessions.error?.api.message ?? "Failed to load."}
            </p>
          </CardContent>
        </Card>
      ) : list.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>No projects yet</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              Create your first project to start tracking sessions and events.
            </p>
            <div className="mt-4">
              <Button onClick={() => setDialogOpen(true)}>+ New project</Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {list.map((p) => (
            <ProjectCard
              key={p.id}
              project={{ id: p.id, name: p.name, ...(p.goal !== undefined ? { goal: p.goal } : {}) }}
              sessions={sessionsByProject.get(p.id) ?? []}
            />
          ))}
        </div>
      )}

      <NewProjectDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onCreated={onCreated}
      />
    </div>
  );
};
