import type { ReactElement } from "react";
import type { ProgressRow } from "@/app/types.ts";
import { OperationOutputDetails } from "./OperationOutputDetails";
import { appCopy, interfaceArgumentLabel } from "@/app/copy.ts";

export function toolDetails(row: ProgressRow, turnId?: string): ReactElement | string | undefined {
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

