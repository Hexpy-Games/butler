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

/**
 * The child's settled status. A terminal child (durable result) is done no
 * matter what its status or progress say; gateways that report the raw
 * result statuses (`completed`, `blocked`) map onto the App statuses.
 */
export function effectiveStewardStatus(
  child: Pick<StewardSessionSummaryView, "status" | "terminal" | "result">,
): string {
  const status: string = child.status;
  if (status === "completed") return "delivered";
  if (status === "blocked") return "failed";
  if (TERMINAL_STEWARD_STATES.has(status)) return status;
  if (!child.terminal) return status;
  switch (child.result?.status) {
    case "success": return "delivered";
    case "cancelled": return "cancelled";
    case "blocked":
    case "failed": return "failed";
    default: return "delivered";
  }
}

export function activeStewardChildren(
  children: StewardSessionSummaryView[] = [],
): StewardSessionSummaryView[] {
  return children.filter((child) => {
    // The native gateway drops `active_turn` once the child's BTCC turn leaves
    // `admitted` (e.g. it is streaming its answer); until a result is
    // committed the child is still working, so its latest turn stands in.
    const turn = child.active_turn ?? (child.terminal ? null : child.latest_turn);
    return Boolean(
      child.waiting_for_children ||
      (turn && ACTIVE_TURN_STATES.has(turn.state)),
    ) &&
      !TERMINAL_STEWARD_STATES.has(effectiveStewardStatus(child));
  });
}

export function stewardProgressStatus(
  child: Pick<
    StewardSessionSummaryView,
    "approved_plan_total" | "approved_plan_completed" | "status" | "terminal" | "result"
  >,
): string {
  const status = effectiveStewardStatus(child);
  if (status === "delivered") return appCopy.interfaceStatus.delivered;
  if (status === "failed") return appCopy.interfaceStatus.failedPast;
  if (status === "cancelled") return appCopy.interfaceStatus.cancelled;
  if (status === "idle") return appCopy.interfaceStatus.idle;
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
  const rows = child.active_turn?.progress?.safe_progress_rows ?? [];
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
    interfaceText(child.active_turn?.progress?.summary_reference, child.active_turn?.progress?.summary ?? "") ||
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
