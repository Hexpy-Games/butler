import type { BtccTurnProgressObserver, ReasoningEffort } from "../contracts.ts";
import type {
  BtccAgentLoop,
  BtccAgentLoopResult,
} from "./contracts.ts";
import type { ModelRoundPort } from "../ports/model-round.ts";
import type { TurnRecord } from "../turn/index.ts";
import type {
  ModelRouteEvent,
  ModelRouteEventResult,
  ModelRouteRecoveryUpdate,
} from "../model-route/index.ts";
import {
  createModelRoutePort,
  currentModelRouteCandidate,
} from "../model-route/index.ts";
import { selectedModelRef } from "./guided-turn-policy.ts";
import { publishOperationalNotice } from "../projection/index.ts";

type GuidedTurnRunInput = Parameters<BtccAgentLoop["run"]>[0];

export function createGuidedModelRouteRuntime(input: {
  turn: TurnRecord;
  baseModelRound: ModelRoundPort;
  progress?: BtccTurnProgressObserver;
  nextSourceRevision: () => number;
  recordModelRouteEvent?: GuidedTurnRunInput["recordModelRouteEvent"];
  loadModelRouteAttemptHistory?: GuidedTurnRunInput["loadModelRouteAttemptHistory"];
  loadModelRoundAcceptance?: GuidedTurnRunInput["loadModelRoundAcceptance"];
  recordModelRoundAcceptance?: GuidedTurnRunInput["recordModelRoundAcceptance"];
}): {
  modelRound: ModelRoundPort;
  activeModelRef: () => string;
  selectedReasoningEffort: ReasoningEffort;
  acceptedModelIdentity: () => BtccAgentLoopResult["modelIdentity"];
} {
  let activeModelRef = selectedModelRef(input.turn);
  let acceptedModelIdentity: BtccAgentLoopResult["modelIdentity"];
  const routedCandidate = input.turn.modelRoute
    ? currentModelRouteCandidate(input.turn.modelRoute)
    : undefined;
  const selectedReasoningEffort = routedCandidate?.reasoningEffort ??
    input.turn.modelSelection.reasoningEffort;
  const onRouteEvent = createGuidedRouteEventHandler({
    turnId: input.turn.turnId,
    semanticState: input.turn.semanticState,
    progress: input.progress,
    nextSourceRevision: input.nextSourceRevision,
    recordModelRouteEvent: input.recordModelRouteEvent,
    setActiveModelRef(modelRef) {
      activeModelRef = modelRef;
    },
  });
  const modelRound = input.turn.modelRoute
    ? createModelRoutePort({
        base: input.baseModelRound,
        turnId: input.turn.turnId,
        route: input.turn.modelRoute,
        onRouteEvent,
        loadAttemptHistory: input.loadModelRouteAttemptHistory,
        loadAcceptedResponse: input.loadModelRoundAcceptance,
        recordAcceptedResponse: input.recordModelRoundAcceptance
          ? async (accepted) => {
              await input.recordModelRoundAcceptance!(accepted);
              acceptedModelIdentity = {
                requestedModelRef: `${input.turn.modelSelection.provider}/${input.turn.modelSelection.model}`,
                effectiveModelRef: accepted.modelRef,
                ...(accepted.result.providerIdentity
                  ? {
                      providerReportedModelRef:
                        accepted.result.providerIdentity.reportedModel.includes("/")
                          ? accepted.result.providerIdentity.reportedModel
                          : `${accepted.result.providerIdentity.provider}/${accepted.result.providerIdentity.reportedModel}`,
                    }
                  : {}),
              };
            }
          : undefined,
        onRecoveryChanged: createGuidedRouteRecoveryHandler({
          turnId: input.turn.turnId,
          semanticState: input.turn.semanticState,
          progress: input.progress,
        }),
      })
    : input.baseModelRound;
  return {
    modelRound,
    activeModelRef: () => activeModelRef,
    selectedReasoningEffort,
    acceptedModelIdentity: () => acceptedModelIdentity,
  };
}

type GuidedRouteEventInput = {
  turnId: string;
  semanticState: string;
  progress?: BtccTurnProgressObserver;
  setActiveModelRef(modelRef: string): void;
  /** Canonical monotonic revision shared with activity projection. */
  nextSourceRevision?: () => number;
  recordModelRouteEvent?: (
    event: ModelRouteEvent,
  ) => ModelRouteEventResult | void | Promise<ModelRouteEventResult | void>;
};

/** Model-route persistence plus bounded public fallback activity projection. */
export function createGuidedRouteEventHandler(input: GuidedRouteEventInput) {
  let pendingFallbackProjection: { roundId: string; modelRef: string } | undefined;
  let localSourceRevision = 0;
  const nextSourceRevision = input.nextSourceRevision ?? (() => ++localSourceRevision);
  return async (event: ModelRouteEvent) => {
    const persisted = await input.recordModelRouteEvent?.(event);
    if (
      event.type === "model.attempt.started" &&
      pendingFallbackProjection?.roundId === event.roundId &&
      pendingFallbackProjection.modelRef === event.modelRef
    ) {
      pendingFallbackProjection = undefined;
      try {
        await input.progress?.modelRoundWaitingChanged?.({
          turnId: input.turnId,
          requestId: event.roundId,
          status: "started",
          modelRef: event.modelRef,
        });
      } catch {
        // Public model identity cannot veto the provider dispatch.
      }
    }
    if (event.type === "model.fallback.selected") {
      input.setActiveModelRef(event.modelRef);
      pendingFallbackProjection = {
        roundId: event.roundId,
        modelRef: event.modelRef,
      };
      try {
        await input.progress?.phaseActivityChanged?.({
          turnId: input.turnId,
          semanticState: input.semanticState,
          originTurnId: input.turnId,
          sourceRevision: nextSourceRevision(),
          activityId: `${input.turnId}:model-fallback:${event.roundId}:${event.candidateIndex}`,
          title: "대체 모델 경로 선택",
          summary: "대체 모델 경로로 계속 진행합니다.",
          modelRef: event.modelRef,
        });
      } catch {
        // Public fallback notice cannot veto the next provider dispatch.
      }
    }
    return persisted;
  };
}

/** Projects the router's real same-model recovery state without owning it. */
export function createGuidedRouteRecoveryHandler(input: {
  turnId: string;
  semanticState: string;
  progress?: BtccTurnProgressObserver;
}) {
  return (update: ModelRouteRecoveryUpdate) => publishOperationalNotice(
    input.progress,
    {
      turnId: input.turnId,
      semanticState: input.semanticState,
      status: update.status,
      activationKind: "automatic_provider_recovery",
      code: update.errorCode,
      attempt: update.attempt,
      maxAttempts: update.maxAttempts,
    },
  );
}
