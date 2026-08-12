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
  const providerOutput = withoutAgentLoopImageAttachments(input.result.output);
  const payload = input.result.ok
    ? { ok: true, output: providerOutput }
    : {
        ok: false,
        error: input.result.error ?? "unknown tool error",
        ...(providerOutput !== undefined ? { output: providerOutput } : {}),
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
    ...(input.operationResultCallId
      ? { operationResultCallId: input.operationResultCallId }
      : {}),
    ...(imageAttachments.length > 0 ? { imageAttachments } : {}),
  };
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
