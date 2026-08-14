import type { ModelRoundMessage } from
  "../../../agent/btcc/ports/model-round.ts";
import type { M1RequestSegmentKind } from
  "../../../agent/btcc/ports/provider-request-attribution.ts";
import { agentLoopImageDataUrl } from
  "../../../agent/tools/tool-result-media.ts";
import { turnItemOrdinal } from
  "../../../agent/btcc/ports/bounded-provider-continuation.ts";

export function openAIBoundedConversationItems(
  messages: readonly ModelRoundMessage[],
  butlerData?: string,
  initialUserItems: readonly Record<string, unknown>[] = [],
): {
  items: Array<Record<string, unknown>>;
  itemKinds: Array<M1RequestSegmentKind | undefined>;
  itemOrdinals: number[];
} {
  let userIndex = 0;
  const items: Array<Record<string, unknown>> = [];
  const itemKinds: Array<M1RequestSegmentKind | undefined> = [];
  const itemOrdinals: number[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      userIndex += 1;
      const next = userIndex === 1 && initialUserItems.length > 0
        ? [...initialUserItems]
        : [{ role: "user", content: [{ type: "input_text", text: message.content }] }];
      items.push(...next);
      itemKinds.push(...next.map(() => message.requestSegmentKind ??
        (userIndex === 1 ? "current_user_request" : "other_typed_context")));
      const ordinal = userIndex === 1 && message.continuationItemId === undefined
        ? 0
        : turnItemOrdinal(message.continuationItemId);
      itemOrdinals.push(...next.map(() => ordinal));
      continue;
    }
    if (message.role === "tool") {
      items.push(openAIToolMessageItems(message, butlerData)[1]);
      itemKinds.push(message.requestSegmentKind ?? "latest_tool_result_delivery");
      itemOrdinals.push(turnItemOrdinal(message.continuationItemId));
      continue;
    }
    if (message.role !== "assistant") continue;
    if (message.content) {
      items.push({
        role: "assistant",
        content: [{ type: "output_text", text: message.content }],
      });
      itemKinds.push("phase_continuity");
      itemOrdinals.push(turnItemOrdinal(message.continuationItemId));
    }
    for (const call of message.toolCalls ?? []) {
      items.push({
        type: "function_call",
        call_id: call.id,
        name: call.name,
        arguments: call.rawArguments ?? JSON.stringify(call.arguments),
      });
      itemKinds.push("phase_continuity");
      itemOrdinals.push(turnItemOrdinal(message.continuationItemId));
    }
  }
  return { items, itemKinds, itemOrdinals };
}

export function selectNewBoundedConversationItems(input: {
  items: readonly Record<string, unknown>[];
  itemKinds: readonly (M1RequestSegmentKind | undefined)[];
  itemOrdinals: readonly number[];
}, deliveredThroughOrdinal: number): {
  items: Array<Record<string, unknown>>;
  itemKinds: Array<M1RequestSegmentKind | undefined>;
} {
  if (input.items.length !== input.itemKinds.length ||
      input.items.length !== input.itemOrdinals.length) {
    throw new Error("bounded_conversation_item_identity_mismatch");
  }
  const items: Array<Record<string, unknown>> = [];
  const itemKinds: Array<M1RequestSegmentKind | undefined> = [];
  input.itemOrdinals.forEach((ordinal, index) => {
    if (ordinal <= deliveredThroughOrdinal) return;
    items.push(input.items[index]!);
    itemKinds.push(input.itemKinds[index]);
  });
  return { items, itemKinds };
}

export function openAIToolMessageItems(
  message: ModelRoundMessage,
  butlerData?: string,
): [Record<string, unknown>, Record<string, unknown>] {
  const images = (message.imageAttachments ?? []).flatMap((attachment) => {
    const imageUrl = agentLoopImageDataUrl(attachment, butlerData);
    return imageUrl
      ? [{ type: "input_image", image_url: imageUrl, detail: "high" }]
      : [];
  });
  const output = images.length > 0
    ? [{ type: "input_text", text: message.content }, ...images]
    : message.content;
  const statelessItem = {
    type: "function_call_output",
    call_id: message.toolCallId,
    output,
  };
  return [{ ...statelessItem, output }, statelessItem];
}
