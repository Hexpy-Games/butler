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

export function toolResultToMessage(input: {
  result: BtccAgentLoopToolResult;
  modelPreviewContext: ToolResultModelPreviewContext;
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
    ...(imageAttachments.length > 0 ? { imageAttachments } : {}),
  };
}
