import type {
  ModelRoundPort,
  ModelRoundRequest,
  PreparedModelRoundPort,
} from "../ports/model-round.ts";
import type {
  BtccAgentLoopInput,
  BtccAgentLoopMessage,
  BtccAgentLoopToolResult,
} from "./contracts.ts";
import { assembleBtccCompactReplayMessages } from
  "./compact-replay-messages.ts";
import { resolveGuidedCompactReplayBudget } from
  "./guided-compact-replay-budget.ts";
import { M1_COMPACT_REPLAY_OPERATION_CARRIER_INSTRUCTION } from
  "../../tools/m1-compact-replay.ts";

const COMPACT_REPLAY_ASSEMBLY = "__butler_btcc_compact_replay" as const;

type CompactReplayAssemblyMetadata = {
  compactReplay: NonNullable<BtccAgentLoopInput["compactReplay"]>;
  messages: readonly BtccAgentLoopMessage[];
  toolResults: readonly BtccAgentLoopToolResult[];
};

type CompactReplayModelRoundRequest = ModelRoundRequest & {
  [COMPACT_REPLAY_ASSEMBLY]?: CompactReplayAssemblyMetadata;
};

export function assembleBtccModelRoundRequest(input: {
  loop: BtccAgentLoopInput;
  requestId: string;
  roundIndex: number;
  modelRef: string;
  messages: readonly BtccAgentLoopMessage[];
  toolResults: readonly BtccAgentLoopToolResult[];
  tools: BtccAgentLoopInput["tools"];
  instructions?: string;
  toolChoice?: "auto" | "required";
  continuation: unknown;
}): ModelRoundRequest {
  const loop = input.loop;
  const metadata = loop.compactReplay?.enabled
    ? {
        compactReplay: loop.compactReplay,
        messages: input.messages,
        toolResults: input.toolResults,
      }
    : undefined;
  const instructions = metadata
    ? assembleBtccProviderInstructions(input.instructions)
    : input.instructions;
  const messages = metadata
    ? compactMessagesForModel(metadata, {
        model: input.modelRef,
        instructions,
        tools: input.tools,
      })
    : [...input.messages];
  return {
    roundId: input.requestId,
    model: input.modelRef,
    messages,
    instructions,
    tools: input.tools,
    toolChoice: input.toolChoice,
    reasoningEffort: loop.reasoningEffort,
    signal: loop.signal,
    attachments: loop.attachments,
    butlerData: loop.butlerData,
    usageAttribution: loop.usageAttribution
      ? { ...loop.usageAttribution, roundIndex: input.roundIndex }
      : undefined,
    cacheScope: loop.cacheScope,
    providerRetryAttempts: loop.providerRetryAttempts,
    continuation: input.continuation,
    onProviderStreamEvent: loop.onProviderStreamEvent,
    onProviderResponseIdentity: loop.onProviderResponseIdentity,
    ...(metadata ? { [COMPACT_REPLAY_ASSEMBLY]: metadata } : {}),
  };
}

export function assembleBtccProviderInstructions(
  instructions: string | undefined,
): string {
  return instructions
    ? `${instructions}\n${M1_COMPACT_REPLAY_OPERATION_CARRIER_INSTRUCTION}`
    : M1_COMPACT_REPLAY_OPERATION_CARRIER_INSTRUCTION;
}

/** Reassembles compact replay after the route has selected its actual model. */
export function createBtccCompactReplayModelRoundPort(
  base: ModelRoundPort,
): PreparedModelRoundPort {
  return {
    prepareRequest(request) {
      const internal = request as CompactReplayModelRoundRequest;
      const metadata = internal[COMPACT_REPLAY_ASSEMBLY];
      const {
        [COMPACT_REPLAY_ASSEMBLY]: _compactReplayAssembly,
        ...providerRequest
      } = internal;
      return metadata
        ? {
            ...providerRequest,
            messages: compactMessagesForModel(metadata, providerRequest),
          }
        : providerRequest;
    },
    async runRound(request) {
      return base.runRound(this.prepareRequest(request));
    },
  };
}

function compactMessagesForModel(
  metadata: CompactReplayAssemblyMetadata,
  request: Pick<ModelRoundRequest, "model" | "instructions" | "tools">,
): BtccAgentLoopMessage[] {
  const modelRef = String(request.model);
  return assembleBtccCompactReplayMessages({
    compactReplay: metadata.compactReplay,
    messages: metadata.messages,
    toolResults: metadata.toolResults,
    modelRef,
    instructions: request.instructions,
    tools: request.tools,
    inputCapacityTokens: resolveGuidedCompactReplayBudget(modelRef)
      .inputCapacityTokens,
  });
}
