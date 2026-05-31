import { useMemo } from "react";
import type { ProjectSummary } from "@/app/types.ts";
import { useButlerStore } from "@/app/store.ts";

interface UseSidebarProjectCollapseReturn {
  projectsCollapsed: boolean;
  collapsedProjectIds: Set<string>;
  toggleProjectCollapse: (projectId: string) => void;
  handleProjectsSectionToggle: (allProjects: ProjectSummary[]) => void;
}

export function useSidebarProjectCollapse(): UseSidebarProjectCollapseReturn {
  const projectsCollapsed = useButlerStore(
    (state) => state.sidebarProjectsCollapsed,
  );
  const collapsedProjectIdsValue = useButlerStore(
    (state) => state.sidebarCollapsedProjectIds,
  );
  const setProjectsCollapsed = useButlerStore(
    (state) => state.setSidebarProjectsCollapsed,
  );
  const setCollapsedProjectIds = useButlerStore(
    (state) => state.setSidebarCollapsedProjectIds,
  );
  const collapsedProjectIds = useMemo(
    () => new Set(collapsedProjectIdsValue),
    [collapsedProjectIdsValue],
  );

  function toggleProjectCollapse(projectId: string) {
    if (projectsCollapsed) {
      setProjectsCollapsed(false);
      setCollapsedProjectIds((prev) =>
        prev.filter((collapsedProjectId) => collapsedProjectId !== projectId),
      );
      return;
    }
    setCollapsedProjectIds((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) {
        next.delete(projectId);
      } else {
        next.add(projectId);
      }
      return [...next];
    });
  }

  function handleProjectsSectionToggle(allProjects: ProjectSummary[]) {
    const allProjectIds = allProjects.map((p) => p.id);
    if (projectsCollapsed) {
      setCollapsedProjectIds([]);
      setProjectsCollapsed(false);
    } else {
      setCollapsedProjectIds(allProjectIds);
      setProjectsCollapsed(true);
    }
  }

  return {
    projectsCollapsed,
    collapsedProjectIds,
    toggleProjectCollapse,
    handleProjectsSectionToggle,
  };
}
