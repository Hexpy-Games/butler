import type { ReactElement } from "react";
import {
  Search,
  FileText,
  Terminal,
  Pencil,
  Rocket,
  Wrench,
  ListChecks,
  type WorkActivityToolItem,
} from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import { isVisibleToolchainProgressRow } from "@/app/utils.ts";
import type { ProgressRow, WorkBlockView } from "@/app/types.ts";
import { OperationOutputDetails } from "./OperationOutputDetails";

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
  return rows.map((row, rowIndex) => ({
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
  return isVisibleToolchainProgressRow(row, blockLabel);
}

export function isTerminalActivityState(state: string): boolean {
  return ["delivered", "failed", "cancelled"].includes(state);
}

export function activityIcon(row: ProgressRow): ReactElement {
  if (row.bridge_phase === "btcc_operation") return <Wrench size={15} />;
  const label = row.safe_label.toLowerCase();
  if (row.kind === "searched" || label.includes("search"))
    return <Search size={15} />;
  if (row.kind === "read" || label.includes("read"))
    return <FileText size={15} />;
  if (row.kind === "ran_command") return <Terminal size={15} />;
  if (row.kind === "edited") return <Pencil size={15} />;
  if (row.kind === "dispatch") return <Rocket size={15} />;
  if (row.kind === "used_tool") return <Wrench size={15} />;
  return <ListChecks size={15} />;
}

export function activityLabel(row: ProgressRow): string {
  return toolchainLabel(row);
}

export function toolchainLabel(row: ProgressRow): string {
  if (row.safe_tool_name && row.safe_input_label) {
    return `${row.safe_tool_name}: ${row.safe_input_label}`;
  }
  return row.safe_tool_name ?? row.safe_input_label ?? "Tool";
}

export function toolchainSummaryLabel(row: ProgressRow): string {
  if (row.bridge_phase === "btcc_operation") return row.safe_label;
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
  if (row.bridge_phase === "btcc_operation") return "작업";
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
