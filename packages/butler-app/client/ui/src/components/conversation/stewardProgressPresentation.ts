import { isVisibleToolActivity } from "@/app/conversation-progress";
import { appCopy, interfaceProgressLabel, interfaceText } from "@/app/copy.ts";
import { ACTIVE_TURN_STATES } from "@/app/constants.ts";
import type {
  ProgressRow,
  StewardSessionSummaryView,
} from "@/app/types.ts";

const TERMINAL_STEWARD_STATES = new Set([
  "delivered",
  "failed",
  "cancelled",
]);

export function activeStewardChildren(
  children: StewardSessionSummaryView[] = [],
): StewardSessionSummaryView[] {
  return children.filter((child) =>
    Boolean(
      child.waiting_for_children ||
      (child.active_turn && ACTIVE_TURN_STATES.has(child.active_turn.state)),
    ) &&
      !TERMINAL_STEWARD_STATES.has(child.status),
  );
}

export function stewardProgressStatus(
  child: Pick<
    StewardSessionSummaryView,
    "approved_plan_total" | "approved_plan_completed" | "status"
  >,
): string {
  if (child.status === "delivered") return appCopy.interfaceStatus.delivered;
  if (child.status === "failed") return appCopy.interfaceStatus.failedPast;
  if (child.status === "cancelled") return appCopy.interfaceStatus.cancelled;
  if (child.status === "idle") return appCopy.interfaceStatus.idle;
  const progress = stewardPlanProgress(child);
  if (progress) return `${appCopy.interfaceStatus.working} · ${progress}`;
  return appCopy.interfaceStatus.working;
}

export function stewardPlanProgress(
  child: Pick<
    StewardSessionSummaryView,
    "approved_plan_total" | "approved_plan_completed"
  >,
): string | null {
  const total = child.approved_plan_total;
  const completed = child.approved_plan_completed;
  if (total === undefined || completed === undefined || total < 1) return null;
  const boundedCompleted = Math.min(total, Math.max(0, completed));
  return `${Math.min(total, boundedCompleted + 1)}/${total}`;
}

export function stewardCurrentActivityTitle(
  child: Pick<StewardSessionSummaryView, "active_turn" | "waiting_for_children">,
): string {
  if (child.waiting_for_children && !child.active_turn) {
    return appCopy.conversation.work.pendingStateLabels.waiting_for_children;
  }
  const rows = child.active_turn?.progress.safe_progress_rows ?? [];
  const activeActivity = latestMatchingRow(rows, (row) =>
    row.kind !== "todo" &&
    row.kind !== "turn" &&
    !isGenericModelRoundActivity(row) &&
    !isModelAuthoredPhaseActivity(row) &&
    (row.state === "running" || row.state === "thinking") &&
    row.safe_label.trim().length > 0,
  );
  const latestActivity = latestMatchingRow(rows, (row) =>
    row.kind !== "todo" &&
    row.kind !== "turn" &&
    !isGenericModelRoundActivity(row) &&
    !isModelAuthoredPhaseActivity(row) &&
    row.safe_label.trim().length > 0,
  );
  const activePlanStep = rows.find((row) =>
    row.kind === "todo" &&
    (row.state === "active" || row.state === "running") &&
    row.safe_label.trim().length > 0,
  );
  const genericActivity = latestMatchingRow(rows, (row) =>
    row.kind !== "todo" &&
    isGenericModelRoundActivity(row) &&
    row.safe_label.trim().length > 0,
  );
  return (
    (activeActivity && interfaceProgressLabel(activeActivity)) ||
    (latestActivity && interfaceProgressLabel(latestActivity)) ||
    (activePlanStep && interfaceProgressLabel(activePlanStep)) ||
    (genericActivity && interfaceProgressLabel(genericActivity)) ||
    interfaceText(child.active_turn?.progress.summary_reference, child.active_turn?.progress.summary ?? "") ||
    appCopy.interfaceStatus.progress
  ).trim().replace(/\s+/gu, " ");
}

function isGenericModelRoundActivity(row: ProgressRow): boolean {
  return row.bridge_phase === "model_round_waiting" ||
    row.safe_tool_name === "model_round";
}

function isModelAuthoredPhaseActivity(row: ProgressRow): boolean {
  return row.work_decision_source === "model-authored";
}

function latestMatchingRow(
  rows: ProgressRow[],
  matches: (row: ProgressRow) => boolean,
): ProgressRow | undefined {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row && matches(row)) return row;
  }
  return undefined;
}

export function stewardToolRows(rows: ProgressRow[]): ProgressRow[] {
  const byTool = new Map<string, ProgressRow>();
  for (const row of rows) {
    if (!isVisibleToolActivity(row, "")) continue;
    byTool.set(
      row.tool_call_id ? `tool:${row.tool_call_id}` : `row:${row.id}`,
      row,
    );
  }
  return [...byTool.values()];
}
