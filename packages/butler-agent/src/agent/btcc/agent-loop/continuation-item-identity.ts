import type { ModelRoundResult } from "../ports/model-round.ts";
import type { BtccAgentLoopMessage } from "./contracts.ts";

export function createTurnContinuationItems(prompt: string, restored?: {
  messages: BtccAgentLoopMessage[]; nextItemOrdinal: number;
}): {
  messages: BtccAgentLoopMessage[];
  nextId(): string;
  ordinal(): number;
  push(message: BtccAgentLoopMessage): void;
  identifyResponse(response: ModelRoundResult, id: string): ModelRoundResult;
} {
  let ordinal = restored?.nextItemOrdinal ?? 0;
  const nextId = () => `turn-item-${ordinal++}`;
  const messages: BtccAgentLoopMessage[] = restored ? structuredClone(restored.messages) : [{
    role: "user", content: prompt, continuationItemId: nextId(),
  }];
  return {
    messages,
    nextId,
    ordinal: () => ordinal,
    push(message) {
      messages.push({
        ...message,
        continuationItemId: message.continuationItemId ?? nextId(),
      });
    },
    identifyResponse(response, id) {
      return {
        ...response,
        assistantMessage: {
          ...(response.assistantMessage ?? {
            role: "assistant", content: response.text ?? "", toolCalls: response.toolCalls,
          }),
          continuationItemId: id,
        },
      };
    },
  };
}
