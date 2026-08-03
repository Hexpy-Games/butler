import {
  serializeToolResultPayloadForProvider,
  type ToolResultModelPreviewContext,
} from "../../../agent/tools/tool-support.ts";

export function hostedToolResultContent(input: {
  payload: Record<string, unknown>;
  toolName: string;
  toolCallId?: string;
  modelPreviewContext?: ToolResultModelPreviewContext;
  log: (line: string) => void;
}): string {
  const content = serializeToolResultPayloadForProvider(input.payload, {
    toolName: input.toolName,
    ...(input.modelPreviewContext
      ? { context: input.modelPreviewContext }
      : {}),
  });
  if (input.payload.ok === true) {
    const modelProjected = Boolean(input.modelPreviewContext) && (
      input.toolName === "web_search" ||
      input.toolName === "web_read" ||
      input.toolName === "run_work_block"
    );
    input.log(modelProjected
      ? `tool ${input.toolName} result projected for model context`
      : `tool ${input.toolName} result serialized exactly`);
  }
  return content;
}
