import type { ReactElement } from "react";
import { type WorkActivityToolItem } from "@/butler-ds";
import { appCopy, getAppLocale, interfaceProgressLabel, interfaceArgumentLabel } from "@/app/copy.ts";
import { isVisibleToolActivity } from "@/app/conversation-progress";
import type { ProgressRow, WorkBlockView } from "@/app/types.ts";
import { OperationOutputDetails } from "./OperationOutputDetails";
import { publicOperationTitle } from
  "../../../../../../butler-progress-projection/src/index.ts";
import { activityIcon } from "./toolchainIcons";
import { WorkerCallCapsule } from "./WorkerCallCapsule";

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
    ...(row.safe_tool_name === "delegate_to_worker" && turnId && row.tool_call_id ? {
      after: <WorkerCallCapsule turnId={turnId} callId={row.tool_call_id} />,
    } : {}),
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
  return row.safe_tool_name ?? row.safe_input_label ?? appCopy.interfaceDetails.tool;
}

export function toolchainSummaryLabel(row: ProgressRow): string {
  if (row.safe_tool_name === "delegate_to_worker") return appCopy.interfaceStatus.workerCall;
  if (row.bridge_phase === "btcc_operation") {
    return interfaceProgressLabel(row) || publicOperationTitle(row.safe_tool_name, getAppLocale());
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
  if (row.safe_tool_name === "delegate_to_worker") return appCopy.interfaceStatus.work;
  if (row.bridge_phase === "btcc_operation") {
    if (row.safe_tool_name === "web_search") return appCopy.interfaceStatus.search;
    if (
      row.safe_tool_name === "web_read" ||
      row.safe_tool_name === "read_file" ||
      row.safe_tool_name === "list_files" ||
      row.safe_tool_name === "grep_files"
    ) {
      return appCopy.interfaceStatus.lookup;
    }
    if (row.safe_tool_name === "edit_file" || row.safe_tool_name === "write_file") {
      return appCopy.interfaceStatus.edit;
    }
    if (row.safe_tool_name === "run_command") return appCopy.interfaceStatus.command;
    return appCopy.interfaceStatus.work;
  }
  const toolName = row.safe_tool_name?.trim();
  if (
    row.kind === "searched" ||
    toolName === "Web search"
  ) {
    return appCopy.interfaceStatus.search;
  }
  if (row.kind === "ran_command" || toolName === "Bash") return "Bash";
  if (row.kind === "read") return toolName || appCopy.interfaceStatus.read;
  if (row.kind === "edited") return appCopy.interfaceStatus.edit;
  if (row.kind === "dispatch") return appCopy.interfaceStatus.work;
  if (toolName && !["Tool", "Used tool", "도구"].includes(toolName)) return toolName;
  return appCopy.interfaceStatus.review;
}

export function toolchainDetailLabel(
  detail: NonNullable<ProgressRow["safe_detail_rows"]>[number],
  row: ProgressRow,
): string {
  const value = detail.safe_value?.trim();
  const label =
    row.kind === "todo" && detail.safe_label.trim().toLowerCase() === "phase"
      ? appCopy.interfaceStatus.phase
      : interfaceArgumentLabel(detail.kind, detail.safe_label);
  if (!value) return label;
  if (row.safe_tool_name === "Web search")
    return appCopy.conversation.work.webSearchDetail(value);
  return appCopy.conversation.work.detailRow(label, value);
}

export function activityDetailId(rowId: string): string {
  return `turn-activity-detail-${rowId.replace(/[^a-zA-Z0-9_-]/gu, "-")}`;
}
