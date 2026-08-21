import { isVisibleToolActivity } from "@/app/conversation-progress";
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
    Boolean(child.active_turn) && !TERMINAL_STEWARD_STATES.has(child.status),
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
  const planTotal = child.approved_plan_total;
  const planCompleted = child.approved_plan_completed;
  if (planTotal !== undefined && planCompleted !== undefined) {
    const total = Math.max(1, planTotal);
    const completed = Math.min(total, Math.max(0, planCompleted));
    return `작업 중 · ${Math.min(total, completed + 1)}/${total}`;
  }
  return "작업 중";
}

export function stewardProgressCapsule(
  child: StewardSessionSummaryView,
): string {
  const turn = child.active_turn;
  if (!turn) return stewardProgressStatus(child);
  const stage = currentStewardStage(
    turn.progress.safe_progress_rows,
    turn.progress.summary,
  );
  return stage
    ? `${stewardProgressStatus(child)} · ${stage}`
    : stewardProgressStatus(child);
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

function currentStewardStage(
  rows: ProgressRow[],
  fallback?: string,
): string | undefined {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (!row || ["completed", "delivered", "skipped"].includes(row.state)) {
      continue;
    }
    if (row.kind === "todo" || row.bridge_phase === "btcc_operation") {
      return boundedStage(row.safe_label);
    }
  }
  return fallback ? boundedStage(fallback) : undefined;
}

function boundedStage(value: string): string {
  return [...value.trim().replace(/\s+/gu, " ")].slice(0, 48).join("");
}
