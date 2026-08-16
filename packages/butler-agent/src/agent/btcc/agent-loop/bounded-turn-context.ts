import type {
  ContextProjectionRebaseIdentity,
  ModelRoundMessage,
  ModelRoundResult,
  ModelRoundTool,
  PhaseContinuityPrivateDigester,
} from "../ports/model-round.ts";
import { PhaseContinuityProjectionError } from "../ports/model-round.ts";
import { continuationRequestDigest } from "../turn/index.ts";
import type { TurnContinuationBudgetState } from "../turn/index.ts";
import { phaseContinuityProjectionIdentity, projectPhaseContinuity } from
  "./phase-continuity-projection.ts";

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
  responseItemId: string;
  phaseContinuityPrivateDigester?: PhaseContinuityPrivateDigester;
  statelessMessageBytes?: (
    messages: readonly ModelRoundMessage[], butlerData?: string,
  ) => number;
  butlerData?: string;
}): Promise<{
  messages: readonly ModelRoundMessage[];
  contextProjection?: ContextProjectionRebaseIdentity;
  envelope?: {
    schemaVersion: "butler.turn-context-envelope.v1";
    modelFacingBytes: number;
    requestDigest: string;
    responseItemId: string;
    contextProjection?: ContextProjectionRebaseIdentity;
    admitProviderBody(serializedBytes: number): Promise<void>;
  };
}> {
  if (!input.budget) return { messages: input.messages };
  const overheadBytes = serializedBytes({
    instructions: input.instructions,
    tools: input.tools,
    toolChoice: input.toolChoice,
    messages: [],
  });
  const messageLimit = Math.max(
    1,
    input.budget.state.limits.maxModelFacingBytes - overheadBytes,
  );
  const exactBounded = buildBoundedTurnContext(input.messages, messageLimit);
  if (exactBounded.evictedAtomicUnits === 0) {
    return finalizeBoundedModelContext(input, exactBounded, overheadBytes);
  }
  const hasReplayCarrier = input.messages.some((message) =>
    message.operationResultReference !== undefined,
  );
  if (!hasReplayCarrier) {
    return finalizeBoundedModelContext(input, exactBounded, overheadBytes);
  }
  if (!input.phaseContinuityPrivateDigester || !input.statelessMessageBytes) {
    throw new PhaseContinuityProjectionError(
      "phase_continuity_projection_dependency_missing",
    );
  }
  const projected = projectPhaseContinuity({
    messages: input.messages,
    digester: input.phaseContinuityPrivateDigester!,
    serializedBytes: (messages) =>
      input.statelessMessageBytes!(messages, input.butlerData),
  });
  const projectedBounded = buildBoundedTurnContext(projected.messages, messageLimit);
  const projectionAdmitted = Boolean(projected.identity) &&
      input.statelessMessageBytes!(projectedBounded.messages, input.butlerData) <
      input.statelessMessageBytes!(exactBounded.messages, input.butlerData);
  if (!projectionAdmitted) {
    return finalizeBoundedModelContext(input, exactBounded, overheadBytes);
  }
  const contextProjection = phaseContinuityProjectionIdentity(projectedBounded.messages);
  if (!contextProjection) {
    return finalizeBoundedModelContext(input, exactBounded, overheadBytes);
  }
  return finalizeBoundedModelContext(
    input,
    projectedBounded,
    overheadBytes,
    contextProjection,
  );
}

function finalizeBoundedModelContext(
  input: Parameters<typeof prepareBoundedModelContext>[0],
  bounded: BoundedTurnContext,
  overheadBytes: number,
  contextProjection?: ContextProjectionRebaseIdentity,
): Awaited<ReturnType<typeof prepareBoundedModelContext>> {
  const modelFacingBytes = overheadBytes + bounded.modelFacingBytes;
  const requestDigest = continuationRequestDigest({
    instructions: input.instructions,
    tools: input.tools,
    toolChoice: input.toolChoice,
    messages: bounded.messages,
  });
  return {
    messages: bounded.messages,
    ...(contextProjection ? { contextProjection } : {}),
    envelope: {
      schemaVersion: "butler.turn-context-envelope.v1",
      modelFacingBytes,
      requestDigest,
      responseItemId: input.responseItemId,
      ...(contextProjection ? { contextProjection } : {}),
      admitProviderBody: async (serializedBytes) => {
        await input.budget!.admitRequest({
          roundId: input.roundId,
          requestDigest,
          modelFacingBytes: serializedBytes,
        });
      },
    },
  };
}

export function modelRoundOutputBytes(response: ModelRoundResult): number {
  return serializedBytes({
    role: "assistant",
    content: response.assistantMessage?.content ?? response.text ?? "",
    toolCalls: response.assistantMessage?.toolCalls ?? response.toolCalls,
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
