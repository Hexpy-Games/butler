import { serializeToolResultPayloadForProvider } from
  "../../tools/tool-result-serialization.ts";
import {
  extractAgentLoopImageAttachments,
  withoutAgentLoopImageAttachments,
} from "../../tools/tool-result-media.ts";
import type { ToolResultModelPreviewContext } from
  "../../tools/tool-result-model-preview.ts";
import type { ToolResultExactReadReference } from
  "../../tools/tool-result-serialization.ts";
import type { OperationResultReference } from
  "../operation-result-replay/index.ts";
import type {
  BtccAgentLoopMessage,
  BtccAgentLoopToolResult,
} from "./contracts.ts";
import { parseToolCatalogId } from "../../tools/progressive-catalog.ts";

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
  operationResultReference?: OperationResultReference;
  exactReadReference?: ToolResultExactReadReference;
}): BtccAgentLoopMessage {
  const toolName = resultToolName(input.result.name, input.result.output);
  const imageAttachments = extractAgentLoopImageAttachments(
    input.result.output,
    toolName,
  );
  const providerOutput = withoutChangedFileDetails(
    toolName === "inspect_workspace_page" ? withoutAgentLoopImageAttachments(input.result.output) : input.result.output,
    toolName,
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
      toolName,
      context: input.modelPreviewContext,
      ...(input.exactReadReference
        ? { exactReadReference: input.exactReadReference }
        : {}),
    }),
    requestSegmentKind: toolResultSegmentKind({ ...input.result, name: toolName }),
    ...(imageAttachments.length > 0 ? { imageAttachments } : {}),
    ...(input.operationResultCallId
      ? { operationResultCallId: input.operationResultCallId }
      : {}),
    ...(input.operationResultReference
      ? { operationResultReference: input.operationResultReference }
      : {}),
  };
}

/** Changed lines are App-only projection data and must never enter a model round. */
export function withoutChangedFileDetails(value: unknown, toolName: string): unknown {
  if (toolName !== "write_file" && toolName !== "edit_file") return value;
  if (Array.isArray(value)) return value.map((entry) => withoutChangedFileDetails(entry, toolName));
  if (!value || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "changed_file" || key === "changed_files" || key === "changedFiles") continue;
    result[key] = withoutChangedFileDetails(entry, toolName);
  }
  return result;
}

function resultToolName(name: string, output: unknown): string {
  if (name !== "tool_call" || !output || typeof output !== "object") return name;
  const bridge = (output as Record<string, unknown>).bridge_invocation;
  if (!bridge || typeof bridge !== "object") return name;
  const id = (bridge as Record<string, unknown>).id;
  if (typeof id !== "string") return name;
  const parsed = parseToolCatalogId(id);
  return parsed?.provider === "native" ? parsed.name : name;
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
