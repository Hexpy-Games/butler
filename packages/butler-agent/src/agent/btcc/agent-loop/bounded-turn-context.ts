import type {
  ModelRoundMessage,
  ModelRoundResult,
  ModelRoundTool,
} from "../ports/model-round.ts";
import { continuationRequestDigest } from "../turn/index.ts";
import type { TurnContinuationBudgetState } from "../turn/index.ts";

export type BoundedTurnContext = {
  messages: readonly ModelRoundMessage[];
  modelFacingBytes: number;
  requestDigest: string;
  evictedAtomicUnits: number;
};

export async function prepareBoundedModelContext(input: {
  messages: readonly ModelRoundMessage[];
  instructions?: string;
  tools: readonly ModelRoundTool[];
  toolChoice?: "auto" | "required";
  budget?: {
    state: TurnContinuationBudgetState;
    admitRequest(value: {
      roundId: string; requestDigest: string; modelFacingBytes: number;
    }): Promise<void>;
  };
  roundId: string;
}): Promise<{
  messages: readonly ModelRoundMessage[];
  envelope?: {
    schemaVersion: "butler.turn-context-envelope.v1";
    modelFacingBytes: number;
    requestDigest: string;
  };
}> {
  if (!input.budget) return { messages: input.messages };
  const overheadBytes = serializedBytes({
    instructions: input.instructions,
    tools: input.tools,
    toolChoice: input.toolChoice,
    messages: [],
  });
  const bounded = buildBoundedTurnContext(input.messages, Math.max(
    1,
    input.budget.state.limits.maxModelFacingBytes - overheadBytes,
  ));
  const modelFacingBytes = overheadBytes + bounded.modelFacingBytes;
  const requestDigest = continuationRequestDigest({
    instructions: input.instructions,
    tools: input.tools,
    toolChoice: input.toolChoice,
    messages: bounded.messages,
  });
  await input.budget.admitRequest({
    roundId: input.roundId,
    requestDigest,
    modelFacingBytes,
  });
  return {
    messages: bounded.messages,
    envelope: {
      schemaVersion: "butler.turn-context-envelope.v1",
      modelFacingBytes,
      requestDigest,
    },
  };
}

export function modelRoundOutputBytes(response: ModelRoundResult): number {
  return serializedBytes(response.assistantMessage ?? {
    role: "assistant",
    content: response.text ?? "",
    toolCalls: response.toolCalls,
  });
}

type AtomicUnit = { messages: ModelRoundMessage[]; mandatory: boolean };

/**
 * Keeps the exact current request and open tool protocol, then admits newest
 * complete conversational units without slicing their content or pairs.
 */
export function buildBoundedTurnContext(
  messages: readonly ModelRoundMessage[],
  maxBytes: number,
): BoundedTurnContext {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("invalid_model_facing_byte_limit");
  if (messages.length === 0 || messages[0]?.role !== "user") throw new Error("turn_current_request_missing");
  const units = atomicUnits(messages);
  const selected = new Set<number>([0]);
  for (let index = 1; index < units.length; index += 1) {
    if (units[index]!.mandatory) selected.add(index);
  }
  let bounded = flatten(units, selected);
  if (serializedBytes(bounded) > maxBytes) {
    const modelFacingBytes = serializedBytes(bounded);
    return {
      messages: bounded,
      modelFacingBytes,
      requestDigest: continuationRequestDigest(bounded),
      evictedAtomicUnits: units.length - selected.size,
    };
  }
  for (let index = units.length - 1; index >= 1; index -= 1) {
    if (selected.has(index)) continue;
    const candidate = new Set(selected).add(index);
    const next = flatten(units, candidate);
    if (serializedBytes(next) <= maxBytes) {
      selected.add(index);
      bounded = next;
    }
  }
  const modelFacingBytes = serializedBytes(bounded);
  return {
    messages: bounded,
    modelFacingBytes,
    requestDigest: continuationRequestDigest(bounded),
    evictedAtomicUnits: units.length - selected.size,
  };
}

function atomicUnits(messages: readonly ModelRoundMessage[]): AtomicUnit[] {
  const units: AtomicUnit[] = [{ messages: [messages[0]!], mandatory: true }];
  let index = 1;
  while (index < messages.length) {
    const message = messages[index]!;
    if (message.role === "tool") throw new Error("turn_tool_protocol_orphan");
    if (message.role !== "assistant" || !message.toolCalls?.length) {
      units.push({ messages: [message], mandatory: false });
      index += 1;
      continue;
    }
    const callIds = new Set(message.toolCalls.map((call) => call.id));
    const unitMessages = [message];
    let cursor = index + 1;
    while (cursor < messages.length && messages[cursor]!.role === "tool") {
      unitMessages.push(messages[cursor]!);
      cursor += 1;
    }
    const resultIds = new Set<string>();
    for (const result of unitMessages.slice(1)) {
      if (!result.toolCallId || !callIds.has(result.toolCallId) ||
          resultIds.has(result.toolCallId)) {
        throw new Error("turn_tool_protocol_orphan");
      }
      resultIds.add(result.toolCallId);
    }
    const mandatory = [...callIds].some((id) => !resultIds.has(id));
    units.push({ messages: unitMessages, mandatory });
    index = cursor;
  }
  if (units.length > 1) units[units.length - 1]!.mandatory = true;
  const newestToolUnit = units.findLastIndex((unit) =>
    unit.messages.some((message) => message.role === "tool"),
  );
  if (newestToolUnit >= 0) units[newestToolUnit]!.mandatory = true;
  return units;
}

function flatten(units: readonly AtomicUnit[], selected: ReadonlySet<number>): ModelRoundMessage[] {
  return units.flatMap((unit, index) => selected.has(index) ? unit.messages : []);
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}
