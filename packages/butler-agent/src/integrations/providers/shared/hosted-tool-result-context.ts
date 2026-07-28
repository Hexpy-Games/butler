import {
  serializeToolResultPayloadForProvider,
} from "../../../agent/model-tool-loop/index.ts";

export function hostedToolResultContent(input: {
  payload: Record<string, unknown>;
  toolName: string;
  toolCallId?: string;
  log: (line: string) => void;
}): string {
  const content = serializeToolResultPayloadForProvider(input.payload);
  if (input.payload.ok === true) {
    input.log(`tool ${input.toolName} result serialized exactly`);
  }
  return content;
}
