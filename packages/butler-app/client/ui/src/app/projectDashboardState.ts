import { create } from "zustand";

interface DashboardViewState {
  tab?: string;
  targetSessionId?: string;
  refreshRevision?: number;
  boardKind?: "work" | "plan" | "task";
  boardParent?: string;
  scrollPositions?: Record<string, number>;
  loadedCounts?: Record<string, number>;
  pendingSend?: { fingerprint: string; clientMessageId: string; sessionId?: string };
}
interface ProjectDashboardState {
  projects: Record<string, DashboardViewState>;
  update: (projectId: string, patch: Partial<DashboardViewState>) => void;
  invalidate: (projectId: string) => void;
}
export const useProjectDashboardState = create<ProjectDashboardState>((set) => ({
  projects: {},
  invalidate: (projectId) => set((state) => ({ projects: { ...state.projects, [projectId]: {
    ...state.projects[projectId], refreshRevision: (state.projects[projectId]?.refreshRevision ?? 0) + 1,
  } } })),
  update: (projectId, patch) => set((state) => ({ projects: { ...state.projects,
    [projectId]: { ...state.projects[projectId], ...patch },
  } })),
}));

export function rememberDashboardLoadedCount(projectId: string, key: string, count: number) {
  const state = useProjectDashboardState.getState();
  if (state.projects[projectId]?.loadedCounts?.[key] === count) return;
  state.update(projectId, { loadedCounts: { ...state.projects[projectId]?.loadedCounts, [key]: count } });
}
