import type { DashboardLedgerSnapshot, DashboardLedgerWork } from "../../../../agent/adapters/btcc/project-ledger/index.ts";
import type { DashboardOverview, DashboardWorkCard } from "../../interface/protocol/session-dashboard-contract.ts";
import { sanitizePublicText } from "../../../../agent/events/public-text.ts";
import { dashboardSessionRunning } from "./project-dashboard-session-links.ts";
import type { SessionSummary } from "../../interface/protocol/app-protocol.ts";

/** A managed execution status and an ordinary Ledger lifecycle are not interchangeable. */
export function dashboardWorkStatus(work: DashboardLedgerWork): DashboardWorkCard["executionStatus"] {
  if (work.availability !== "ready") return "unknown";
  if (work.managed) return work.managed.status;
  if (work.record.status === "done") return "completed";
  if (work.record.status === "cancelled") return "abandoned";
  if (work.record.status === "blocked") return "blocked";
  if (["proposed", "scoped", "specified", "in_progress", "review"].includes(work.record.status)) return "open";
  return "unknown";
}

export function projectDashboardFacts(snapshot: DashboardLedgerSnapshot, sessionForWork: (id: string) => SessionSummary | null = () => null): Extract<DashboardOverview, { status: "ready" }> {
  const progress = { completed: 0, open: 0, blocked: 0, abandoned: 0, unknown: 0 };
  const ranks = new Map(snapshot.works.map((work) => {
    const disposition = work.managed?.latestDisposition;
    const checkpoint = work.managed?.latestCheckpoint;
    const remaining = disposition && (!checkpoint || disposition.createdAt >= checkpoint.createdAt) && disposition.remainingActions.length;
    return [work.record.id, dashboardWorkStatus(work) === "blocked" || remaining ? 0 :
      work.managed && dashboardSessionRunning(sessionForWork(work.managed.sessionId)) ? 1 : 2];
  }));
  const cards = snapshot.works.map((work): DashboardWorkCard => {
    const executionStatus = dashboardWorkStatus(work);
    progress[executionStatus] += 1;
    const tasks = snapshot.records.filter((record) => record.kind === "task" && record.parentId === work.record.id);
    return {
      id: work.record.id, title: sanitizePublicText(work.managed?.objective ?? work.record.title, ""), executionStatus, ledgerStatus: work.record.status,
      authorityKind: work.managed ? "managed_work" : "ledger_record",
      revision: work.revision, updatedAt: work.record.updatedAt, priority: work.record.priority,
      taskProgress: tasks.length ? { done: tasks.filter((task) => task.status === "done").length, total: tasks.length } : null,
    };
  });
  const remaining = cards.filter((card) => card.executionStatus === "open" || card.executionStatus === "blocked")
    .sort((a, b) => ranks.get(a.id)! - ranks.get(b.id)! ||
      a.priority - b.priority || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  return { status: "ready", sourceRevision: snapshot.revision, observedAt: snapshot.observedAt,
    totalWorks: cards.length, progress, remaining: remaining.slice(0, 5), remainingCount: remaining.length };
}
