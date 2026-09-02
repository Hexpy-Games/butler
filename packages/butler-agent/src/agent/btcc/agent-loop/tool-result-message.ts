import { serializeToolResultPayloadForProvider } from
  "../../tools/tool-result-serialization.ts";
import {
  extractAgentLoopImageAttachments,
  withoutAgentLoopImageAttachments,
} from "../../tools/tool-result-media.ts";
import type { ToolResultModelPreviewContext } from
  "../../tools/tool-result-model-preview.ts";
import type {
  BtccAgentLoopMessage,
  BtccAgentLoopToolResult,
} from "./contracts.ts";

const SOURCE_RESULT_TOOLS = new Set(["web_search", "web_read", "read_mcp_resource"]);
const WORK_RECOVERY_TOOLS = new Set([
  "start_work",
  "continue_work",
  "replace_work_plan",
  "record_work_checkpoint",
  "record_work_review",
  "record_work_disposition",
]);

export function toolResultToMessage(input: {
  result: BtccAgentLoopToolResult;
  modelPreviewContext: ToolResultModelPreviewContext;
  operationResultCallId?: string;
}): BtccAgentLoopMessage {
  const imageAttachments = extractAgentLoopImageAttachments(
    input.result.output,
    input.result.name,
  );
  const providerOutput = withoutChangedFileDetails(
    withoutAgentLoopImageAttachments(input.result.output),
  );
  const payload = input.result.ok
    ? { ok: true, output: providerOutput }
    : {
        ok: false,
        error: input.result.error,
        ...(providerOutput === undefined ? {} : { output: providerOutput }),
      };
  return {
    role: "tool",
    toolCallId: input.result.toolCallId,
    name: input.result.name,
    content: serializeToolResultPayloadForProvider(payload, {
      toolName: input.result.name,
      context: input.modelPreviewContext,
    }),
    requestSegmentKind: toolResultSegmentKind(input.result),
    ...(imageAttachments.length > 0 ? { imageAttachments } : {}),
    ...(input.operationResultCallId
      ? { operationResultCallId: input.operationResultCallId }
      : {}),
  };
}

/** Changed lines are App-only projection data and must never enter a model round. */
export function withoutChangedFileDetails(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutChangedFileDetails);
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "changed_file" || key === "changed_files" || key === "changedFiles") continue;
    result[key] = withoutChangedFileDetails(entry);
  }
  return result;
}

function toolResultSegmentKind(
  result: BtccAgentLoopToolResult,
): BtccAgentLoopMessage["requestSegmentKind"] {
  if (result.name === "read_operation_results") return "exact_result_view";
  if (/^(?:recall_memory|query_memory)$/u.test(result.name)) return "memory_recall_context";
  if (SOURCE_RESULT_TOOLS.has(result.name)) return "source_reference";
  if (!result.ok && (
    result.name.startsWith("project_ledger_") || WORK_RECOVERY_TOOLS.has(result.name)
  )) {
    return "work_recovery_receipt";
  }
  return "latest_tool_result_delivery";
}
