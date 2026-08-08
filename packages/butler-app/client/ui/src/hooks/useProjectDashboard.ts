import { useEffect, useState } from "react";
import { api } from "@/app/api.ts";
import { notifyError } from "@/app/notifications.ts";
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
  const [dashboard, setDashboard] = useState<ProjectDashboardData | null>(
    initialDashboard ?? null,
  );

  useEffect(() => {
    if (!projectId) return;
    // Treat initialDashboard as a first-render seed only. When this hook is
    // backing the active project dashboard, refetch on every dashboard
    // activation; openProjectDashboard creates a new view object even when
    // re-opening the currently selected project.
    if (initialDashboard && !dashboardActivation) return;
    let cancelled = false;
    api<ProjectDashboardData>(
      `/projects/${encodeURIComponent(projectId)}/dashboard`,
    )
      .then((data) => {
        if (!cancelled) setDashboard(data);
      })
      .catch((error) => {
        if (!cancelled) {
          notifyError(error, "Project dashboard failed", {
            id: `project-dashboard-${projectId}`,
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [dashboardActivation, initialDashboard, projectId]);

  return {
    dashboard,
    project,
    sessions: navigationProject
      ? navigationProject.sessions ?? []
      : dashboard?.project.sessions ?? project?.sessions ?? [],
  };
}
