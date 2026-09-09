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
    input.log(`tool ${input.toolName} result projected for model context`);
  }
  return content;
}
