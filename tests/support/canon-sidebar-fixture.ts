import type { CanonOverview, CanonSidebar, EpicCard } from "../../packages/butler-app/client/shared/canon-contracts.ts";
/** Offline focus traversal fixture; product reads the same wire contracts as native smoke. */
const epic: EpicCard = {
  id: "focus-epic", project_id: "butler", plan_id: "focus-plan", sessions: [{ session_id: "butler-client", bound_at: 0, bound_by: "{}", origin: "user" }],
  title: "과제 화면 확인", description: "화면을 확인합니다.", kind: null, canon_status: "planned", canon_status_source: "person",
  assignee: "app-user", plan_rank: "a", origin: "dialog", revision: 1, task_counts: { total: 0 },
};
export const focusCanon: CanonOverview = { project_id: "butler", backlog_revision: 0, backlog: [], plans: [{
  id: "focus-plan", project_id: "butler", title: "화면 계획", description: "키보드로 확인합니다.", due_on: null, status: "open", revision: 1, works: [epic],
}] };
export const focusCanonSidebar: CanonSidebar = { project_id: "butler", groups: [
  { key: "backlog", kind: "backlog", title: "백로그", rows: [] },
  { key: "focus-plan", kind: "plan", title: "화면 계획", plan_revision: 1, rows: [epic] },
] };
export function canonFocusResponse(path: string): unknown | undefined {
  if (path === "/projects/butler/canon/sidebar") return focusCanonSidebar;
  if (path === "/projects/butler/canon") return focusCanon;
  if (path === "/canon/epics/focus-epic") return { ...epic, specs: [], tasks: [] };
  return undefined;
}
