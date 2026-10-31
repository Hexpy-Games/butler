import { create } from "zustand";
import type { CanonSidebar, CanonOverview, EpicCard } from "./canonApi.ts";

type SessionEpic = { projectId: string; group: string; epic: EpicCard };
interface CanonSidebarState {
  projects: Record<string, CanonSidebar>;
  sessions: Record<string, SessionEpic[]>;
  forgetEpic: (projectId: string, epicId: string) => void;
  rememberSidebar: (sidebar: CanonSidebar) => void;
  rememberCanon: (canon: CanonOverview) => void;
}
function sessionIndex(projectId: string, groups: Array<{ title: string; rows: EpicCard[] }>, previous: Record<string, SessionEpic[]>) {
  const sessions: Record<string, SessionEpic[]> = Object.fromEntries(Object.entries(previous)
    .map(([id, matches]): [string, SessionEpic[]] => [id, matches.filter(match => match.projectId !== projectId)])
    .filter(([, matches]) => matches.length > 0));
  for (const group of groups) for (const epic of group.rows) {
    if (epic.home_session_id) (sessions[epic.home_session_id] ??= []).push({ projectId, group: group.title, epic });
  }
  return sessions;
}
/** Indexed at read completion; conversation renders never scan the project's works. */
export const useCanonSidebarState = create<CanonSidebarState>(set => ({
  projects: {}, sessions: {},
  forgetEpic: (projectId, epicId) => set(state => {
    const sidebar = state.projects[projectId];
    return {
      projects: sidebar ? { ...state.projects, [projectId]: { ...sidebar, groups: sidebar.groups.map(group => ({ ...group, rows: group.rows.filter(epic => epic.id !== epicId) })) } } : state.projects,
      sessions: Object.fromEntries(Object.entries(state.sessions).map(([id, matches]): [string, SessionEpic[]] => [id, matches.filter(match => match.epic.id !== epicId)]).filter(([, matches]) => matches.length > 0)),
    };
  }),
  rememberSidebar: sidebar => set(state => ({
    projects: { ...state.projects, [sidebar.project_id]: sidebar },
    sessions: sessionIndex(sidebar.project_id, sidebar.groups.map(group => ({ ...group, title: group.kind === "backlog" ? "" : group.title })), state.sessions),
  })),
  rememberCanon: canon => set(state => ({ sessions: sessionIndex(canon.project_id, [
    { title: "", rows: canon.backlog }, ...canon.plans.map(plan => ({ title: plan.title, rows: plan.works })),
  ], state.sessions) })),
}));
