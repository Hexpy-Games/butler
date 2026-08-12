import type { ModelRoundMessage } from
  "../../../agent/btcc/ports/model-round.ts";
import type { M1RequestSegmentKind } from
  "../../../agent/btcc/ports/provider-request-attribution.ts";
import { agentLoopImageDataUrl } from
  "../../../agent/tools/tool-result-media.ts";

export function openAIBoundedConversationItems(
  messages: readonly ModelRoundMessage[],
  butlerData?: string,
  initialUserItems: readonly Record<string, unknown>[] = [],
): {
  items: Array<Record<string, unknown>>;
  itemKinds: Array<M1RequestSegmentKind | undefined>;
  itemKeys: string[];
} {
  let userIndex = 0;
  let protocolAnchor = "context";
  const items: Array<Record<string, unknown>> = [];
  const itemKinds: Array<M1RequestSegmentKind | undefined> = [];
  const itemKeys: string[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      userIndex += 1;
      const next = userIndex === 1 && initialUserItems.length > 0
        ? [...initialUserItems]
        : [{ role: "user", content: [{ type: "input_text", text: message.content }] }];
      items.push(...next);
      itemKinds.push(...next.map(() => message.requestSegmentKind ??
        (userIndex === 1 ? "current_user_request" : "other_typed_context")));
      itemKeys.push(...next.map((_item, itemIndex) => userIndex === 1
        ? `current-user:${itemIndex}`
        : `turn-message:${requiredTurnItemId(message)}`));
      continue;
    }
    if (message.role === "tool") {
      items.push(openAIToolMessageItems(message, butlerData)[1]);
      itemKinds.push(message.requestSegmentKind ?? "latest_tool_result_delivery");
      itemKeys.push(`tool-output:${message.toolCallId}`);
      protocolAnchor = message.toolCallId ?? protocolAnchor;
      continue;
    }
    if (message.role !== "assistant") continue;
    if (message.content) {
      items.push({
        role: "assistant",
        content: [{ type: "output_text", text: message.content }],
      });
      itemKinds.push("phase_continuity");
      itemKeys.push(`turn-message:${requiredTurnItemId(message)}`);
    }
    for (const call of message.toolCalls ?? []) {
      items.push({
        type: "function_call",
        call_id: call.id,
        name: call.name,
        arguments: call.rawArguments ?? JSON.stringify(call.arguments),
      });
      itemKinds.push("phase_continuity");
      itemKeys.push(`function-call:${call.id}`);
      protocolAnchor = call.id;
    }
  }
  return { items, itemKinds, itemKeys };
}

export function openAIResponseItemKeys(input: {
  text: string;
  functionCalls: readonly Record<string, unknown>[];
  responseItemId: string;
}): string[] {
  return [
    ...(input.text ? [`turn-message:${requiredIdentity(input.responseItemId)}`] : []),
    ...input.functionCalls.flatMap((call) =>
      typeof call.call_id === "string" ? [`function-call:${call.call_id}`] : []),
  ];
}

function requiredTurnItemId(message: ModelRoundMessage): string {
  return requiredIdentity(message.continuationItemId);
}

function requiredIdentity(value: string | undefined): string {
  if (!value || !/^[A-Za-z0-9_.:-]{1,160}$/u.test(value)) {
    throw new Error("bounded_continuation_turn_item_identity_missing");
  }
  return value;
}

export function selectNewBoundedConversationItems(input: {
  items: readonly Record<string, unknown>[];
  itemKinds: readonly (M1RequestSegmentKind | undefined)[];
  itemKeys: readonly string[];
}, priorKeys: readonly string[]): {
  items: Array<Record<string, unknown>>;
  itemKinds: Array<M1RequestSegmentKind | undefined>;
} {
  if (input.items.length !== input.itemKinds.length ||
      input.items.length !== input.itemKeys.length) {
    throw new Error("bounded_conversation_item_identity_mismatch");
  }
  const prior = new Set(priorKeys);
  const items: Array<Record<string, unknown>> = [];
  const itemKinds: Array<M1RequestSegmentKind | undefined> = [];
  input.itemKeys.forEach((key, index) => {
    if (prior.has(key)) return;
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
