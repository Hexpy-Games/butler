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
/**
 * A conversation shared by several 과제 has one live state. It rests on the steps being
 * worked on or waiting on a decision; once none is, on the one that finished last.
 */
export function carriesSessionState(shared: SessionEpic[] | undefined, id: string): boolean {
  if (!shared || shared.length < 2) return true;
  const epics = shared.map(match => match.epic);
  const live = epics.filter(epic => epic.queue?.state === "running");
  if (live.length > 0) return live.some(epic => epic.id === id);
  const finished = epics.filter(epic => epic.queue?.state === "done")
    .reduce<EpicCard | undefined>((last, epic) => (epic.queue?.finished_at ?? 0) >= (last?.queue?.finished_at ?? 0) ? epic : last, undefined);
  if (finished) return finished.id === id;
  const working = epics.filter(epic => epic.running);
  return working.length > 0 ? working.some(epic => epic.id === id) : epics[0]!.id === id;
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
