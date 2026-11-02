import type { CanonOverview, EpicCard } from "../../packages/butler-app/client/shared/canon-contracts.ts";
import type { CanonProposal } from "../../packages/butler-app/client/shared/canon-proposal-contracts.ts";
export const epicCards: EpicCard[] = [
  { id: "release", title: "릴리스 확인", criteria: { confirmed: 2, total: 3 }, assignee: "app-user", task_counts: { completed: 2, total: 4 } },
  { id: "docs", title: "문서 검토", criteria: { confirmed: 1, total: 1 }, assignee: "버틀러", agent: { person: "버틀러", via: "API" }, task_counts: { completed: 3, total: 3 } },
  { id: "cancelled", title: "이전 계획", canon_status: "cancelled", task_counts: { completed: 0, total: 2 } },
].map(card => ({ project_id: "butler", plan_id: null, home_session_id: null, session_ids: [], sessions: [], description: "검토 범위와 완료 조건", kind: null,
  canon_status: "planned", canon_status_source: "person", assignee: null, plan_rank: null, origin: "board", revision: 1,
  tags: [{ id: "quality", name: "품질", color: "blue" }, { id: "preview", name: "프리뷰", color: "purple" }], ...card } as EpicCard));
export const epicOverview: CanonOverview = { project_id: "butler", backlog_revision: 1, backlog: [epicCards[0], epicCards[2]], plans: [{
  id: "review-plan", project_id: "butler", title: "검토", description: "검토 계획", due_on: null, status: "open", revision: 1, works: [epicCards[1]],
}] };
export const epicOrder = ["docs", "release", "cancelled", "deleted"];
export const appliedProposal: CanonProposal = { proposal_id: "registration", session_id: "butler-client", state: "applied", summary: "과제 등록", target_label: "릴리스 확인",
  project: { id: "butler", name: "제품" }, plan: null, changes: [{ op: "epic.create", id: "release", title: "릴리스 확인" }], epics: [], created_at: "2026-11-02T08:00:00Z", resolved_by: null };
