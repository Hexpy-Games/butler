import { useEffect, useState } from "react";
import { api } from "@/app/api.ts";
import { useButlerStore } from "@/app/store.ts";
import type {
  ProjectDashboardView as ProjectDashboardData,
  ProjectSummary,
} from "@/app/types.ts";

export function useProjectDashboard({
  initialDashboard,
  project: projectProp,
}: {
  initialDashboard?: ProjectDashboardData | null;
  project?: ProjectSummary;
}) {
  const view = useButlerStore((state) => state.view);
  const navigation = useButlerStore((state) => state.navigation);
  const projectIdFromView = view.kind === "project-dashboard"
    ? view.projectId
    : projectProp?.id;
  const navigationProject = projectIdFromView
    ? (navigation.projects ?? []).find((item) => item.id === projectIdFromView)
    : undefined;
  const project = navigationProject ?? projectProp;
  const projectId = project?.id;
  const dashboardActivation =
    view.kind === "project-dashboard" && view.projectId === projectId
      ? view
      : null;
  const [retry, setRetry] = useState(0);
  const [request, setRequest] = useState<{
    projectId?: string; status: "loading" | "ready" | "error";
    data: ProjectDashboardData | null;
  }>({ projectId: initialDashboard?.project.id, status: initialDashboard ? "ready" : "loading",
    data: initialDashboard ?? null });
  const status = !projectId ? "missing" : request.projectId !== projectId ? "loading" : request.status;
  const dashboard = status === "ready" ? request.data : null;

  useEffect(() => {
    if (!projectId) return;
    // Treat initialDashboard as a first-render seed only. When this hook is
    // backing the active project dashboard, refetch on every dashboard
    // activation; openProjectDashboard creates a new view object even when
    // re-opening the currently selected project.
    if (initialDashboard && !dashboardActivation) return;
    let cancelled = false;
    setRequest({ projectId, status: "loading", data: null });
    api<ProjectDashboardData>(
      `/projects/${encodeURIComponent(projectId)}/dashboard`,
    )
      .then((data) => {
        if (!cancelled) setRequest({ projectId, status: "ready", data });
      })
      .catch(() => {
        if (!cancelled) setRequest({ projectId, status: "error", data: null });
      });
    return () => {
      cancelled = true;
    };
  }, [dashboardActivation, initialDashboard, projectId, retry]);

  return {
    dashboard,
    status,
    retry: () => setRetry((value) => value + 1),
    project,
    sessions: navigationProject
      ? navigationProject.sessions ?? []
      : dashboard?.project.sessions ?? project?.sessions ?? [],
  };
}
