import type { ModelRoundMessage } from
  "../../../agent/btcc/ports/model-round.ts";
import { turnItemOrdinal } from
  "../../../agent/btcc/ports/bounded-provider-continuation.ts";

export function openAIBoundedConversationItems(
  messages: readonly ModelRoundMessage[],
  _butlerData?: string,
  initialUserItems: readonly Record<string, unknown>[] = [],
): {
  items: Array<Record<string, unknown>>;
  itemOrdinals: number[];
} {
  let userIndex = 0;
  const items: Array<Record<string, unknown>> = [];
  const itemOrdinals: number[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      userIndex += 1;
      const next = userIndex === 1 && initialUserItems.length > 0
        ? [...initialUserItems]
        : [{ role: "user", content: [{ type: "input_text", text: message.content }] }];
      items.push(...next);
      const ordinal = userIndex === 1 && message.continuationItemId === undefined
        ? 0
        : turnItemOrdinal(message.continuationItemId);
      itemOrdinals.push(...next.map(() => ordinal));
      continue;
    }
    if (message.role === "tool") {
      items.push(openAIToolMessageItems(message)[1]);
      itemOrdinals.push(turnItemOrdinal(message.continuationItemId));
      continue;
    }
    if (message.role !== "assistant") continue;
    if (message.content) {
      items.push({
        role: "assistant",
        content: [{ type: "output_text", text: message.content }],
      });
      itemOrdinals.push(turnItemOrdinal(message.continuationItemId));
    }
    for (const call of message.toolCalls ?? []) {
      items.push({
        type: "function_call",
        call_id: call.id,
        name: call.name,
        arguments: call.rawArguments ?? JSON.stringify(call.arguments),
      });
      itemOrdinals.push(turnItemOrdinal(message.continuationItemId));
    }
  }
  return { items, itemOrdinals };
}

export function openAIBoundedConversationSerializedBytes(
  messages: readonly ModelRoundMessage[],
  butlerData?: string,
): number {
  return Buffer.byteLength(JSON.stringify(
    openAIBoundedConversationItems(messages, butlerData).items,
  ), "utf8");
}

export function openAIInitialRequestSerializedBytes(
  input: { prompt: string; instructions: string },
  butlerData?: string,
): number {
  const initial = openAIBoundedConversationItems([{
    role: "user",
    content: input.prompt,
    continuationItemId: "turn-item-0",
  }], butlerData).items;
  return Buffer.byteLength(JSON.stringify({
    instructions: input.instructions,
    input: initial,
  }), "utf8");
}

export function selectNewBoundedConversationItems(input: {
  items: readonly Record<string, unknown>[];
  itemOrdinals: readonly number[];
}, deliveredThroughOrdinal: number): {
  items: Array<Record<string, unknown>>;
} {
  if (input.items.length !== input.itemOrdinals.length) {
    throw new Error("bounded_conversation_item_identity_mismatch");
  }
  const items: Array<Record<string, unknown>> = [];
  input.itemOrdinals.forEach((ordinal, index) => {
    if (ordinal <= deliveredThroughOrdinal) return;
    items.push(input.items[index]!);
  });
  return { items };
}

export function openAIToolMessageItems(
  message: ModelRoundMessage,
): [Record<string, unknown>, Record<string, unknown>] {
  const statelessItem = {
    type: "function_call_output",
    call_id: message.toolCallId,
    output: message.content,
  };
  return [statelessItem, statelessItem];
}
