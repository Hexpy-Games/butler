import { create } from "zustand";
import type { CanonSidebar, CanonOverview, EpicCard } from "./canonApi.ts";

type SessionEpic = { projectId: string; group: string; epic: EpicCard };
interface CanonSidebarState {
  projects: Record<string, CanonSidebar>;
  sessions: Record<string, SessionEpic>;
  rememberSidebar: (sidebar: CanonSidebar) => void;
  rememberCanon: (canon: CanonOverview) => void;
}
function sessionIndex(projectId: string, groups: Array<{ title: string; rows: EpicCard[] }>, previous: Record<string, SessionEpic>) {
  const sessions = Object.fromEntries(Object.entries(previous).filter(([, value]) => value.projectId !== projectId));
  for (const group of groups) for (const epic of group.rows) {
    if (epic.home_session_id) sessions[epic.home_session_id] = { projectId, group: group.title, epic };
  }
  return sessions;
}
/** Indexed at read completion; conversation renders never scan the project's works. */
export const useCanonSidebarState = create<CanonSidebarState>(set => ({
  projects: {}, sessions: {},
  rememberSidebar: sidebar => set(state => ({
    projects: { ...state.projects, [sidebar.project_id]: sidebar },
    sessions: sessionIndex(sidebar.project_id, sidebar.groups.map(group => ({ ...group, title: group.kind === "backlog" ? "" : group.title })), state.sessions),
  })),
  rememberCanon: canon => set(state => ({ sessions: sessionIndex(canon.project_id, [
    { title: "", rows: canon.backlog }, ...canon.plans.map(plan => ({ title: plan.title, rows: plan.works })),
  ], state.sessions) })),
}));
