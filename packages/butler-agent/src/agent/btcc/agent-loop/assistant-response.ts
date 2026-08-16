import type { ModelRoundResult } from "../ports/model-round.ts";
import type {
  BtccAgentLoopMessage,
  BtccAgentLoopToolCall,
} from "./contracts.ts";

export function appendAssistantResponse(
  messages: BtccAgentLoopMessage[],
  response: ModelRoundResult,
): { text: string; calls: BtccAgentLoopToolCall[] } {
  const text = response.text?.trim() ?? "";
  const calls = response.toolCalls ?? [];
  if (text || calls.length > 0) {
    messages.push(response.assistantMessage ?? {
      role: "assistant",
      content: text,
      toolCalls: calls,
      providerData: response.raw,
    });
  }
  return { text, calls };
}
