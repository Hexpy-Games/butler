import { useEffect, useMemo, useRef, useState } from "react";
import { useProjectDashboardState } from "@/app/projectDashboardState.ts";
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
  const invalidation = useProjectDashboardState((state) => projectId ? state.projects[projectId]?.refreshRevision ?? 0 : 0);
  const firstDirtyAt = useRef<number | null>(null);
  useEffect(() => { firstDirtyAt.current = null; }, [projectId]);
  useEffect(() => {
    if (!dashboardActivation || !invalidation) return;
    firstDirtyAt.current ??= Date.now();
    const timer = setTimeout(() => {
      firstDirtyAt.current = null;
      if (document.visibilityState !== "hidden") setRetry((value) => value + 1);
    }, Math.min(2000, Math.max(0, 10000 - (Date.now() - firstDirtyAt.current))));
    return () => clearTimeout(timer);
  }, [invalidation, projectId, dashboardActivation]);
  useEffect(() => {
    if (!dashboardActivation) return;
    const refresh = () => { if (document.visibilityState !== "hidden") setRetry((value) => value + 1); };
    const timer = setInterval(refresh, 30000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => { clearInterval(timer); window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, [dashboardActivation, projectId]);
  const [request, setRequest] = useState<{
    projectId?: string; status: "loading" | "ready" | "error";
    data: ProjectDashboardData | null; refreshFailed?: boolean;
  }>({ projectId: initialDashboard?.project.id, status: initialDashboard ? "ready" : "loading",
    data: initialDashboard ?? null });
  const status = !projectId ? "missing" : request.projectId !== projectId ? "loading" : request.status;
  const dashboard = status === "ready" ? request.data : null;
  const sessions = useMemo(() => {
    // Navigation receives live title/status changes while the dashboard request is in flight.
    // Keep the full dashboard catalog, but do not overwrite newer live rows with a stale response.
    const merged = new Map((dashboard?.project.sessions ?? project?.sessions ?? []).map((session) => [session.id, session]));
    for (const session of navigationProject?.sessions ?? []) {
      const old = merged.get(session.id);
      if (!old || (session.updated_at ?? session.last_activity_at ?? "") >= (old.updated_at ?? old.last_activity_at ?? "")) merged.set(session.id, session);
    }
    return [...merged.values()];
  }, [dashboard?.project.sessions, project?.sessions, navigationProject?.sessions]);

  useEffect(() => {
    if (!projectId) return;
    // Treat initialDashboard as a first-render seed only. When this hook is
    // backing the active project dashboard, refetch on every dashboard
    // activation; openProjectDashboard creates a new view object even when
    // re-opening the currently selected project.
    if (initialDashboard && !dashboardActivation) return;
    let cancelled = false;
    // A refresh must not unmount the persistent composer or discard its files.
    // Data from another project is never retained across a scope change.
    setRequest((current) => current.projectId === projectId && current.data
      ? { ...current, refreshFailed: false }
      : { projectId, status: "loading", data: null });
    api<ProjectDashboardData>(
      `/projects/${encodeURIComponent(projectId)}/dashboard`,
    )
      .then((data) => {
        if (!cancelled) setRequest({ projectId, status: "ready", data });
      })
      .catch(() => {
        if (!cancelled) setRequest((current) => current.projectId === projectId && current.data
          ? { ...current, refreshFailed: true }
          : { projectId, status: "error", data: null });
      });
    return () => {
      cancelled = true;
    };
  }, [dashboardActivation, initialDashboard, projectId, retry]);

  return {
    dashboard,
    status,
    refreshFailed: request.projectId === projectId && request.refreshFailed === true,
    retry: () => setRetry((value) => value + 1),
    project,
    sessions,
  };
}
