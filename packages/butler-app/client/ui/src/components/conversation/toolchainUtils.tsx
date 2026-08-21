import type { ReactElement } from "react";
import { type WorkActivityToolItem } from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import { isVisibleToolActivity } from "@/app/conversation-progress";
import type { ProgressRow, WorkBlockView } from "@/app/types.ts";
import { OperationOutputDetails } from "./OperationOutputDetails";
import { publicOperationTitle } from
  "../../../../../../butler-progress-projection/src/index.ts";
import { activityIcon } from "./toolchainIcons";

export { activityIcon } from "./toolchainIcons";

const WORK_BOOKKEEPING_TOOL_NAMES = new Set([
  "start_work",
  "continue_work",
  "replace_work_plan",
  "record_work_checkpoint",
  "record_work_review",
  "record_work_disposition",
]);

export function toolchainRowsForBlock(block: WorkBlockView): ProgressRow[] {
  return block.rows.filter((row) => isVisibleToolchainRow(row, block.label));
}

export function workActivityToolsForBlock(
  block: WorkBlockView,
  turnId?: string,
): WorkActivityToolItem[] {
  return workActivityToolsFromRows(toolchainRowsForBlock(block), turnId);
}

export function workActivityToolsFromRows(
  rows: ProgressRow[],
  turnId?: string,
): WorkActivityToolItem[] {
  return rows
    .filter((row) => !(
      row.safe_tool_name && WORK_BOOKKEEPING_TOOL_NAMES.has(row.safe_tool_name)
    ))
    .map((row, rowIndex) => ({
    id: `${row.id}:${rowIndex}`,
    icon: activityIcon(row),
    title: toolchainSummaryLabel(row),
    summaryLabel: toolchainGroupLabel(row),
    details: toolDetails(row, turnId),
    }));
}

function toolDetails(row: ProgressRow, turnId?: string): ReactElement | string | undefined {
  if (turnId && row.tool_call_id && row.tool_result_id) {
    return (
      <OperationOutputDetails
        requestId={row.tool_call_id}
        resultId={row.tool_result_id}
        toolName={row.safe_tool_name}
        turnId={turnId}
      />
    );
  }
  return row.safe_detail_rows
    ?.map((detail) => toolchainDetailLabel(detail, row))
    .join(" ");
}

export function isVisibleToolchainRow(
  row: ProgressRow,
  blockLabel: string,
): boolean {
  return isVisibleToolActivity(row, blockLabel);
}

export function isTerminalActivityState(state: string): boolean {
  return ["delivered", "failed", "cancelled"].includes(state);
}

export function toolchainLabel(row: ProgressRow): string {
  if (row.safe_tool_name && row.safe_input_label) {
    return `${row.safe_tool_name}: ${row.safe_input_label}`;
  }
  return row.safe_tool_name ?? row.safe_input_label ?? "Tool";
}

export function toolchainSummaryLabel(row: ProgressRow): string {
  if (row.bridge_phase === "btcc_operation") {
    return row.safe_label || publicOperationTitle(row.safe_tool_name);
  }
  const detailCount = row.safe_detail_rows?.length ?? 0;
  const firstDetail = row.safe_detail_rows?.[0];
  if (row.kind === "todo" && !row.safe_tool_name && firstDetail) {
    return toolchainDetailLabel(firstDetail, row);
  }
  if (row.safe_tool_name === "Web search" && detailCount > 1) {
    return appCopy.conversation.work.webSearchSummary(detailCount);
  }
  if (row.safe_tool_name && detailCount > 1) {
    return appCopy.conversation.work.toolStepsSummary(
      row.safe_tool_name,
      detailCount,
    );
  }
  return toolchainLabel(row);
}

export function toolchainGroupLabel(row: ProgressRow): string {
  if (row.bridge_phase === "btcc_operation") {
    if (row.safe_tool_name === "web_search") return "검색";
    if (
      row.safe_tool_name === "web_read" ||
      row.safe_tool_name === "read_file" ||
      row.safe_tool_name === "list_files" ||
      row.safe_tool_name === "grep_files"
    ) {
      return "조회";
    }
    if (row.safe_tool_name === "edit_file" || row.safe_tool_name === "write_file") {
      return "편집";
    }
    if (row.safe_tool_name === "run_command") return "명령";
    return "작업";
  }
  const toolName = row.safe_tool_name?.trim();
  if (
    row.kind === "searched" ||
    toolName === "Web search"
  ) {
    return "검색";
  }
  if (row.kind === "ran_command" || toolName === "Bash") return "Bash";
  if (row.kind === "read") return toolName || "읽기";
  if (row.kind === "edited") return "편집";
  if (row.kind === "dispatch") return "작업";
  if (toolName && !isGenericToolName(toolName)) return toolName;
  return "검토";
}

function isGenericToolName(value: string): boolean {
  return ["Tool", "Used tool", "도구"].includes(value);
}

export function toolchainDetailLabel(
  detail: NonNullable<ProgressRow["safe_detail_rows"]>[number],
  row: ProgressRow,
): string {
  const value = detail.safe_value?.trim();
  const label =
    row.kind === "todo" && detail.safe_label.trim().toLowerCase() === "phase"
      ? "단계"
      : detail.safe_label;
  if (!value) return label;
  if (row.safe_tool_name === "Web search")
    return appCopy.conversation.work.webSearchDetail(value);
  return appCopy.conversation.work.detailRow(label, value);
}

export function activityDetailId(rowId: string): string {
  return `turn-activity-detail-${rowId.replace(/[^a-zA-Z0-9_-]/gu, "-")}`;
}
