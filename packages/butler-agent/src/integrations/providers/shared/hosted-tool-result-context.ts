import {
  serializeToolResultPayloadForProvider,
} from "../../../agent/context/completed-tool-evidence.ts";
import type { ToolEvidenceRetentionContext } from "../../../agent/context/tool-evidence-retention.ts";

export function hostedToolResultContent(input: {
  payload: Record<string, unknown>;
  toolName: string;
  toolCallId?: string;
  log: (line: string) => void;
  evidenceRetention?: ToolEvidenceRetentionContext;
}): string {
  const content = serializeToolResultPayloadForProvider(input);
  if (input.payload.ok === true) {
    input.log(`tool ${input.toolName} result retained as completed evidence`);
  }
  return content;
}
