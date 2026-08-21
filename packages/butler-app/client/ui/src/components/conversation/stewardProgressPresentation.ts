import { isVisibleToolActivity } from "@/app/conversation-progress";
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
    Boolean(child.active_turn && ACTIVE_TURN_STATES.has(child.active_turn.state)) &&
      !TERMINAL_STEWARD_STATES.has(child.status),
  );
}

export function stewardProgressStatus(
  child: Pick<
    StewardSessionSummaryView,
    "approved_plan_total" | "approved_plan_completed" | "status"
  >,
): string {
  if (child.status === "delivered") return "완료됨";
  if (child.status === "failed") return "실패함";
  if (child.status === "cancelled") return "중단됨";
  if (child.status === "idle") return "대기 중";
  const progress = stewardPlanProgress(child);
  if (progress) return `작업 중 · ${progress}`;
  return "작업 중";
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
  child: Pick<StewardSessionSummaryView, "active_turn">,
): string {
  const rows = child.active_turn?.progress.safe_progress_rows ?? [];
  const activeActivity = latestMatchingRow(rows, (row) =>
    row.kind !== "todo" &&
    (row.state === "running" || row.state === "thinking") &&
    row.safe_label.trim().length > 0,
  );
  const activePlanStep = rows.find((row) =>
    row.kind === "todo" &&
    (row.state === "active" || row.state === "running") &&
    row.safe_label.trim().length > 0,
  );
  const latestActivity = latestMatchingRow(rows, (row) =>
    row.kind !== "todo" && row.safe_label.trim().length > 0,
  );
  return (
    activeActivity?.safe_label ||
    activePlanStep?.safe_label ||
    latestActivity?.safe_label ||
    child.active_turn?.progress.summary ||
    "작업 진행 중"
  ).trim().replace(/\s+/gu, " ");
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
