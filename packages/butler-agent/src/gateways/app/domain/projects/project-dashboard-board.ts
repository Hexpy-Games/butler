import type { DashboardLedgerSnapshot } from "../../../../agent/adapters/btcc/project-ledger/index.ts";
import type { DashboardBoardCard, SessionSummary } from "../../interface/protocol/app-protocol.ts";
import { dashboardWorkStatus } from "./project-dashboard-facts.ts";
import { sanitizePublicText } from "../../../../agent/events/public-text.ts";
import { dashboardSessionRunning } from "./project-dashboard-session-links.ts";

export function projectDashboardBoard(
  snapshot: DashboardLedgerSnapshot,
  kind: DashboardBoardCard["kind"],
  sessionForWork: (sessionId: string) => SessionSummary | null,
): DashboardBoardCard[] {
  const workCards = snapshot.works.map((work): DashboardBoardCard => {
    const status = dashboardWorkStatus(work);
    const tasks = snapshot.records.filter((record) => record.kind === "task" && record.parentId === work.record.id);
    const actions = work.managed?.actionProgress;
    const session = work.managed ? sessionForWork(work.managed.sessionId) : null;
    return { id: work.record.id, kind: "work", title: sanitizePublicText(work.managed?.objective ?? work.record.title, ""), parentId: null,
      status, lane: workLane(status, work.record.status, work.managed?.currentStage), updatedAt: work.record.updatedAt,
      taskProgress: tasks.length ? { done: tasks.filter((task) => task.status === "done").length, total: tasks.length } : null,
      actionProgress: actions ? { done: actions.filter((action) => action.status === "done").length, total: actions.length } : null,
      session: session ? { id: session.id, title: sanitizePublicText(session.title, ""), running: status === "open" &&
        dashboardSessionRunning(session) } : null,
    };
  });
  if (kind === "work") return workCards;
  const managed = snapshot.works.filter((work) => work.managed?.currentPlan);
  const managedWorkIds = new Set(managed.map((work) => work.record.id));
  const cards = snapshot.records.filter((record) => record.kind === kind &&
    (kind !== "plan" || !managedWorkIds.has(record.parentId ?? ""))).map((record): DashboardBoardCard => {
    const parent = workCards.find((work) => work.id === record.parentId);
    return { id: record.id, kind, title: sanitizePublicText(record.title, ""), parentId: record.parentId, status: record.status,
      lane: recordLane(record.status), updatedAt: record.updatedAt, taskProgress: null, actionProgress: null,
      session: parent?.session ? { ...parent.session, running: parent.session.running && recordLane(record.status) === "active" } : null };
  });
  if (kind === "plan") for (const work of managed) {
    const plan = work.managed!.currentPlan!;
    const parent = workCards.find((card) => card.id === work.record.id)!;
    cards.push({ ...parent, id: plan.planRevisionId, kind: "plan", title: sanitizePublicText(plan.objective, ""),
      parentId: work.record.id, taskProgress: null, updatedAt: plan.createdAt });
  }
  return cards;
}

function workLane(status: string, ledgerStatus: string, stage?: string): DashboardBoardCard["lane"] {
  if (status === "completed") return "done";
  if (status === "blocked") return "blocked";
  if (status === "unknown" || status === "abandoned") return "other";
  if (ledgerStatus === "review" || stage === "review") return "review";
  return ["proposed", "scoped", "specified"].includes(ledgerStatus) ? "planned" : "active";
}
function recordLane(status: string): DashboardBoardCard["lane"] {
  if (["done", "completed", "accepted"].includes(status)) return "done";
  if (status === "blocked") return "blocked";
  if (status === "review") return "review";
  if (["active", "in_progress"].includes(status)) return "active";
  if (["todo", "draft", "proposed", "scoped", "specified", "planned"].includes(status)) return "planned";
  return "other";
}
/** Fair global pages preserve recency within each lane without starving active work. */
export function interleaveDashboardLanes(cards: DashboardBoardCard[]): DashboardBoardCard[] {
  const lanes = ["planned", "active", "review", "blocked", "done", "other"] as const;
  const buckets = lanes.map((lane) => cards.filter((card) => card.lane === lane));
  const result: DashboardBoardCard[] = [];
  const longest = Math.max(0, ...buckets.map((bucket) => bucket.length));
  for (let index = 0; index < longest; index++) {
    for (const bucket of buckets) if (bucket[index]) result.push(bucket[index]!);
  }
  return result;
}
