import type { BtccAgentLoopInput, BtccAgentLoopMessage } from "./contracts.ts";
import type { ModelRoundResult } from "../ports/model-round.ts";
import { publishModelRoundWaiting } from "./guided-tool-progress.ts";
import { modelRoundOutputBytes, prepareBoundedModelContext } from "./bounded-turn-context.ts";
import { resolveRoundToolSurface } from "./round-tool-surface.ts";
import { continuationForContextProjection } from "../model-route/context-projection-rebase.ts";
import type { createTurnContinuationItems } from "./continuation-item-identity.ts";
import { modelRoundRequestId } from "./agent-loop-round.ts";
import { ContextCapacityExceededError, isContextLimitError } from "./context-capacity.ts";

export type AgentLoopRoundRequest = {
  tools: readonly BtccAgentLoopInput["tools"][number][]; toolSurfaceDigest?: string;
  instructions?: string;
  toolChoice?: "auto" | "required";
  iteration: number;
};

type Observation = string | { content: string; requestSegmentKind: "current_user_request" | "project_ledger_and_work_authority" };

/**
 * One model round: bounded context, provider call, continuation bookkeeping.
 * A provider context-limit rejection compacts harder and retries once; if it
 * still cannot fit, the user receives an actionable capacity escalation.
 */
export function createAgentLoopModelRound(state: {
  input: BtccAgentLoopInput;
  messages: BtccAgentLoopMessage[];
  continuationItems: ReturnType<typeof createTurnContinuationItems>;
  appendObservation(observation: Observation): void;
  claimRoundIndex(): number;
  onDirection(): void;
  getContinuation(): unknown;
  setContinuation(value: unknown): void;
}): (request: AgentLoopRoundRequest) => Promise<ModelRoundResult> {
  const { input, messages, continuationItems } = state;
  const resolveModelRef = () => input.resolveModelRef?.() ?? input.model ?? "";
  const runOnce = async (request: AgentLoopRoundRequest, aggressive: boolean): Promise<ModelRoundResult> => {
    const roundIndex = (input.usageAttribution?.roundIndex ?? 0) + state.claimRoundIndex();
    const requestId = modelRoundRequestId(roundIndex, input.recoveryAttempt);
    const publishWaiting = async (status: "started" | "completed" | "failed" | "cancelled"): Promise<void> => {
      if (!input.turnId) return;
      const modelRef = resolveModelRef();
      await publishModelRoundWaiting(input.progress, {
        turnId: input.turnId, requestId, status, ...(modelRef ? { modelRef } : {}),
      });
    };
    await publishWaiting("started");
    try {
      // Final synthesis may append an ordinary user instruction to this same
      // history; give it the same canonical identity before provider projection.
      for (const message of messages) message.continuationItemId ??= continuationItems.nextId();
      let responseItemId = continuationItems.nextId();
      const replayMessages = input.operationResultReplay
        ? input.operationResultReplay.prepareMessages(messages, requestId, { statelessMessageBytes: input.modelRound.statelessMessageBytes, butlerData: input.butlerData })
        : [...messages];
      const prepareContext = () => prepareBoundedModelContext({
        // Summarize semantic history, not the transport's acknowledged handles.
        messages: input.contextCompactor ? messages : replayMessages,
        instructions: request.instructions, tools: request.tools, toolChoice: request.toolChoice,
        budget: input.continuationBudget, compactor: input.contextCompactor, aggressive,
        contextSizing: input.modelRound.contextSizing?.({ model: resolveModelRef(),
          instructions: request.instructions, tools: request.tools, attachments: input.attachments, butlerData: input.butlerData }),
        maxModelFacingBytes: input.maxModelFacingBytes,
        roundId: requestId, responseItemId,
        phaseContinuityPrivateDigester: input.phaseContinuityPrivateDigester,
        statelessMessageBytes: input.modelRound.statelessMessageBytes, butlerData: input.butlerData,
      });
      let bounded = await prepareContext();
      if (input.contextCompactor && bounded.requiresRebase) {
        const directions = await input.beforeModelRound?.() ?? [];
        for (const observation of directions) state.appendObservation(observation);
        if (directions.length) {
          if (directions.some((observation) => typeof observation === "string" ||
            observation.requestSegmentKind === "current_user_request")) {
            state.onDirection();
            const surface = await resolveRoundToolSurface(input.resolveTools, input.tools);
            request.tools = surface.tools;
            request.toolSurfaceDigest = surface.toolSurfaceDigest;
            request.toolChoice = input.resolveToolChoice?.() ?? input.toolChoice;
          }
          responseItemId = continuationItems.nextId();
          bounded = await prepareContext();
        }
      }
      const roundContinuation = continuationForContextProjection({
        boundedContinuation: bounded.envelope, continuation: state.getContinuation(),
      });
      const response = await input.modelRound.runRound({
        roundId: requestId, model: resolveModelRef(), messages: bounded.messages,
        instructions: request.instructions, tools: request.tools,
        ...(request.toolSurfaceDigest ? { toolSurfaceDigest: request.toolSurfaceDigest } : {}),
        toolChoice: request.toolChoice, reasoningEffort: input.reasoningEffort, signal: input.signal,
        attachments: input.attachments, imageCarrier: input.imageCarrier, imageCapability: input.imageCapability,
        imageManifests: input.imageManifests, verifiedImagePayloadPort: input.verifiedImagePayloadPort,
        butlerData: input.butlerData,
        usageAttribution: input.usageAttribution ? { ...input.usageAttribution, roundIndex } : undefined,
        cacheScope: input.cacheScope, stableProviderCachePrefix: input.stableProviderCachePrefix,
        providerRetryAttempts: input.providerRetryAttempts, continuation: roundContinuation,
        ...(bounded.envelope ? { boundedContinuation: bounded.envelope } : {}),
        onProviderStreamEvent: input.onProviderStreamEvent,
        onProviderResponseIdentity: input.onProviderResponseIdentity,
      });
      input.operationResultReplay?.accepted(requestId, response);
      if (input.continuationBudget) {
        await input.continuationBudget.recordOutput({ roundId: requestId, outputBytes: modelRoundOutputBytes(response) });
      }
      state.setContinuation(response.continuation);
      await publishWaiting("completed");
      return continuationItems.identifyResponse(response, responseItemId);
    } catch (error) {
      input.operationResultReplay?.failed(requestId);
      await publishWaiting(input.signal?.aborted ? "cancelled" : "failed");
      throw error;
    }
  };
  return async (request) => {
    try {
      return await runOnce(request, false);
    } catch (error) {
      if (!isContextLimitError(error) || input.signal?.aborted) throw error;
      if (!input.contextCompactor) throw new ContextCapacityExceededError("current request");
      // The provider measured more than our estimate: compact harder, retry once.
      state.setContinuation(undefined);
      try {
        return await runOnce(request, true);
      } catch (retryError) {
        if (isContextLimitError(retryError)) throw new ContextCapacityExceededError("current request");
        throw retryError;
      }
    }
  };
}
