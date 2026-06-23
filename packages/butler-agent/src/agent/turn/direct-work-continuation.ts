import { sanitizePublicText } from "../events/turn-events.ts";
import { TodoListStore } from "../work/todo-list.ts";
import {
  type WorkStreamState,
  WorkStreamStore,
} from "../work/work-stream.ts";
import type { ToolAuditEntry } from "./native-tool-types.ts";

export const RUNTIME_SEMANTIC_TODO_LIST_ID = "runtime-semantic";

export interface OpenDirectWorkBlocker {
  title: string;
  state: string;
  phase: string | null;
  listId: string | null;
  activeItems: Array<{
    id: string;
    label: string;
    status: string;
    phase: string | null;
  }>;
}

export interface DirectWorkProgressSnapshot {
  kind: "none" | "active";
  id?: string;
  state?: WorkStreamState;
  phase?: string | null;
  deliverable?: boolean;
  completedCount?: number;
  unfinishedCount?: number;
}

const DIRECT_WORK_FORWARD_STATE_RANK: Partial<Record<WorkStreamState, number>> = {
  routing: 0,
  conception: 1,
  planning: 2,
  executing: 3,
  reviewing: 4,
  consolidating: 5,
  reporting: 6,
};
const CONTINUATION_NEXT_ACTION_LINES = [
  "- Use the structured tool-call channel to execute the remaining direct work",
  "  or to move the WorkStream to a legitimate deliverable state.",
  "- Update `update_todo_list` as evidence is gathered and steps complete.",
  "- Do not treat repeated status inspection, diff review, or replanning as progress",
  "  unless the remaining WorkStream steps actually move toward completion.",
  "- Keep the response focused on the remaining work and evidence,",
  "  without meta-narrating runtime control flow.",
  "- Do not answer with a promise, plan, or 'I will start now' message.",
  "- Final delivery is allowed only after the direct WorkStream has no unfinished active items,",
  "  reaches reporting/waiting_user/paused/recoverable with evidence,",
  "  or is linked to an async worker/planned/orchestration stream.",
];

export function activeDirectWorkProgressSnapshot(input: {
  butlerData: string;
  sessionId: string;
}): DirectWorkProgressSnapshot {
  const workStream = new WorkStreamStore(input.butlerData).activeForSession(input.sessionId);
  if (!workStream || workStream.todo_list_id === RUNTIME_SEMANTIC_TODO_LIST_ID) {
    return { kind: "none" };
  }
  if (
    workStream.linked_planned_task_ids.length > 0 ||
    workStream.linked_orchestration_ids.length > 0 ||
    workStream.linked_worker_task_ids.length > 0
  ) {
    return { kind: "none" };
  }

  const view = workStream.todo_list_id
    ? new TodoListStore(input.butlerData).view(workStream.todo_list_id, { includeCompleted: true })
    : null;
  const items = view?.list.items ?? [];
  const completedCount = items.filter((item) => item.status === "completed").length;
  const unfinishedCount = items.filter((item) =>
    item.status === "pending" || item.status === "in_progress",
  ).length;
  const deliverable =
    workStream.state === "reporting" ||
    workStream.state === "waiting_user" ||
    workStream.state === "paused" ||
    workStream.state === "recoverable" ||
    (view !== null && unfinishedCount === 0);

  return {
    kind: "active",
    id: workStream.id,
    state: workStream.state,
    phase: workStream.current_phase,
    deliverable,
    completedCount,
    unfinishedCount,
  };
}

export function directWorkSemanticProgressAdvanced(
  before: DirectWorkProgressSnapshot,
  after: DirectWorkProgressSnapshot,
): boolean {
  if (before.kind === "none" && after.kind === "none") return false;
  if (before.kind === "none" && after.kind === "active") return true;
  if (before.kind === "active" && after.kind === "none") return true;
  if (before.kind !== "active" || after.kind !== "active") return false;
  if (before.id !== after.id) {
    return (
      (after.completedCount ?? 0) > (before.completedCount ?? 0) ||
      (after.unfinishedCount ?? 0) < (before.unfinishedCount ?? 0) ||
      directWorkFsmProgressAdvanced(before, after) ||
      (after.deliverable === true && before.deliverable !== true)
    );
  }
  if (after.deliverable === true && before.deliverable !== true) return true;
  if ((after.completedCount ?? 0) > (before.completedCount ?? 0)) return true;
  if ((after.unfinishedCount ?? 0) < (before.unfinishedCount ?? 0)) return true;
  return directWorkFsmProgressAdvanced(before, after);
}

export function turnAdvancedDuringToolPrompt(input: {
  beforeWork: DirectWorkProgressSnapshot;
  afterWork: DirectWorkProgressSnapshot;
  successfulToolsBefore: number;
  successfulToolsAfter: number;
}): boolean {
  if (input.beforeWork.kind === "active" || input.afterWork.kind === "active") {
    return directWorkSemanticProgressAdvanced(input.beforeWork, input.afterWork);
  }
  return input.successfulToolsAfter > input.successfulToolsBefore;
}

export function finalDeliveryBlockerForOpenDirectWork(input: {
  butlerData: string;
  sessionId: string;
}): OpenDirectWorkBlocker | null {
  const workStream = new WorkStreamStore(input.butlerData).activeForSession(input.sessionId);
  if (!workStream || workStream.todo_list_id === RUNTIME_SEMANTIC_TODO_LIST_ID) return null;
  if (
    workStream.linked_planned_task_ids.length > 0 ||
    workStream.linked_orchestration_ids.length > 0 ||
    workStream.linked_worker_task_ids.length > 0 ||
    workStream.state === "reporting" ||
    workStream.state === "waiting_user" ||
    workStream.state === "paused" ||
    workStream.state === "recoverable"
  ) {
    return null;
  }

  const view = workStream.todo_list_id
    ? new TodoListStore(input.butlerData).view(workStream.todo_list_id, { includeCompleted: true })
    : null;
  const activeItems = view?.list.items
    .filter((item) => item.status === "pending" || item.status === "in_progress")
    .map((item) => ({
      id: item.id,
      label: item.status === "in_progress" ? item.active_form : item.content,
      status: item.status,
      phase: item.phase,
    })) ?? [];

  if (view && activeItems.length === 0) return null;
  return {
    title: workStream.title,
    state: workStream.state,
    phase: workStream.current_phase,
    listId: workStream.todo_list_id,
    activeItems: activeItems.slice(0, 8),
  };
}

export function openDirectWorkContinuationPrompt(input: {
  objective: string;
  personaContext?: string;
  audit: ToolAuditEntry[];
  blocker: OpenDirectWorkBlocker;
}): string {
  const activeItems = input.blocker.activeItems.length > 0
    ? input.blocker.activeItems
      .map((item, index) =>
        `${index + 1}. [${item.status}${item.phase ? `/${item.phase}` : ""}] ${item.label}`)
      .join("\n")
    : "- Active direct work stream has not reached a deliverable state.";
  const evidence = compactContinuationEvidence(input.audit);
  const personaContext = compactContinuationPersonaContext(input.personaContext);
  return [
    "## Direct Work Continuation",
    "Continue the same logical Butler WorkStream as ordinary same-turn progress.",
    "",
    ...(personaContext ? ["Persona continuation:", personaContext, ""] : []),
    "Current WorkStream:",
    `- title: ${input.blocker.title}`,
    `- state: ${input.blocker.state}`,
    `- phase: ${input.blocker.phase ?? "unknown"}`,
    `- todo_list_id: ${input.blocker.listId ?? "none"}`,
    "",
    "Remaining direct steps:",
    activeItems,
    "",
    "Continuity note:",
    `- objective: ${compactObjectiveText(input.objective, 500)}`,
    ...evidence.map((line) => `- ${line}`),
    "",
    "Next action:",
    ...CONTINUATION_NEXT_ACTION_LINES,
  ].join("\n");
}

function directWorkFsmProgressAdvanced(
  before: DirectWorkProgressSnapshot,
  after: DirectWorkProgressSnapshot,
): boolean {
  if (before.kind !== "active" || after.kind !== "active") return false;
  if (!before.state || !after.state || before.state === after.state) return false;
  if (
    (after.state === "waiting_user" || after.state === "paused" || after.state === "recoverable") &&
    before.state !== after.state
  ) {
    return true;
  }
  if (before.state === "reviewing" && after.state === "executing") return true;
  const beforeRank = DIRECT_WORK_FORWARD_STATE_RANK[before.state];
  const afterRank = DIRECT_WORK_FORWARD_STATE_RANK[after.state];
  return beforeRank !== undefined && afterRank !== undefined && afterRank > beforeRank;
}

function compactContinuationPersonaContext(value?: string): string {
  const section = value?.trim() ?? "";
  return section ? compactContinuationText(section, 1_500) : "";
}

function compactObjectiveText(value: string, maxChars: number): string {
  return compactContinuationText(value, maxChars, "same user request");
}

function compactContinuationEvidence(audit: ToolAuditEntry[]): string[] {
  const recent = audit.filter((entry) => entry.ok).slice(-6);
  if (recent.length === 0) return ["recent evidence: none yet"];
  return recent.map((entry, index) => {
    const receipts = (entry.evidenceReceipts ?? [])
      .map((receipt) =>
        compactContinuationText(receipt.summary, 120) ||
        compactContinuationText(receipt.receiptType, 120))
      .filter(Boolean)
      .slice(0, 2);
    const receiptText = receipts.length > 0 ? `; receipts: ${receipts.join(" | ")}` : "";
    return `evidence ${index + 1}: ${entry.name}${receiptText}`;
  });
}

function compactContinuationText(value: string, maxChars: number, fallback = ""): string {
  const normalized = sanitizePublicText(value, "").replace(/\s+/g, " ").trim();
  if (!normalized) return fallback;
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars - 1).trimEnd()}...`;
}
