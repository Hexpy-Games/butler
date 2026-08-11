import type {
  ModelRouteEvent,
  ModelRouteEventHandler,
  ModelRouteEventResult,
} from "../model-route/index.ts";
import { createModelRoutePort } from "../model-route/index.ts";
import type {
  ModelRoundPort,
  PreparedModelRoundPort,
} from "../ports/model-round.ts";
import type { BtccTurnProgressObserver } from "../contracts.ts";
import type { StateExecutionClaim, TurnRecord } from "../turn/index.ts";
import { TurnContinuationBudgetStorageError } from "../turn/index.ts";
import { digest, stableJson } from "../identity/index.ts";
import {
  M1_BOUNDED_CONTINUATION_CACHE_FLAG_REVISION,
} from "../../tools/m1-bounded-continuation-cache.ts";
import { createM1ContinuationProgressRecorder } from
  "../../../operations/metrics/m1-continuation-progress.ts";
import {
  guidedDynamicInstructions,
  guidedInstructions,
  guidedStableInstructions,
} from "./guided-turn-prompt.ts";
import type { guidedPolicy } from "./guided-turn-policy.ts";
import { assembleBtccProviderInstructions } from
  "./model-round-request-assembly.ts";
import { createGuidedRouteEventHandler } from "./guided-turn-route-events.ts";

export type GuidedTurnContinuationSelection =
  | { enabled: false }
  | {
    enabled: true;
    limits: NonNullable<TurnRecord["continuationBudget"]>["limits"];
  };
export type GuidedTurnContinuationObservation = ReturnType<
  typeof createM1ContinuationProgressRecorder
>;

export function admitGuidedTurnContinuation(input: {
  turn: TurnRecord;
  recordModelRouteEvent?: unknown;
  loadModelRouteAttemptHistory?: unknown;
  loadModelRoundAcceptance?: unknown;
  recordModelRoundAcceptance?: unknown;
  executionClaim?: StateExecutionClaim;
}): GuidedTurnContinuationSelection {
  const selection: GuidedTurnContinuationSelection = input.turn.continuationBudget
    ? { enabled: true, limits: input.turn.continuationBudget.limits }
    : { enabled: false };
  if (selection.enabled &&
      (!input.turn.modelRoute || !input.recordModelRouteEvent ||
        !input.loadModelRouteAttemptHistory || !input.loadModelRoundAcceptance ||
        !input.recordModelRoundAcceptance || !input.executionClaim)) {
    throw new TurnContinuationBudgetStorageError(input.turn.turnId);
  }
  return selection;
}

export function observeGuidedTurnContinuation(input: {
  selection: GuidedTurnContinuationSelection;
  turn: TurnRecord;
  butlerData: string;
  policy: ReturnType<typeof guidedPolicy>;
  compactReplayEnabled: boolean;
}): GuidedTurnContinuationObservation | undefined {
  if (!input.selection.enabled || !input.turn.modelRoute) return undefined;
  const stableInstructions = guidedStableInstructions(input.policy);
  return createM1ContinuationProgressRecorder({
    butlerData: input.butlerData,
    turnId: input.turn.turnId,
    routeDigest: input.turn.modelRoute.routeDigest,
    cachePrefixHash: digest(stableJson({
      instructions: input.compactReplayEnabled
        ? assembleBtccProviderInstructions(stableInstructions)
        : stableInstructions,
    })),
    flagRevision: M1_BOUNDED_CONTINUATION_CACHE_FLAG_REVISION,
  });
}

export function observeContinuationRouteEvents(
  record: ModelRouteEventHandler | undefined,
  observation: GuidedTurnContinuationObservation | undefined,
): ((event: ModelRouteEvent) => Promise<ModelRouteEventResult | void>) | undefined {
  if (!record) return undefined;
  return async (event) => {
    try {
      const result = await record(event);
      observation?.observeRouteEvent(event);
      return result;
    } catch (error) {
      observation?.observeError(error);
      throw error;
    }
  };
}

type RoutedModelRoundInput = Parameters<typeof createModelRoutePort>[0];

export function createGuidedContinuationModelRound(input: {
  base: PreparedModelRoundPort;
  turn: TurnRecord;
  progress?: BtccTurnProgressObserver;
  recordModelRouteEvent?: ModelRouteEventHandler;
  observation?: GuidedTurnContinuationObservation;
  onFallbackSelected: (event: ModelRouteEvent) => void;
  loadAttemptHistory?: RoutedModelRoundInput["loadAttemptHistory"];
  loadAcceptedResponse?: RoutedModelRoundInput["loadAcceptedResponse"];
  recordAcceptedResponse?: RoutedModelRoundInput["recordAcceptedResponse"];
  selection: GuidedTurnContinuationSelection;
}): ModelRoundPort {
  if (!input.turn.modelRoute) return input.base;
  const common = {
    base: input.base,
    turnId: input.turn.turnId,
    route: input.turn.modelRoute,
    onRouteEvent: createGuidedRouteEventHandler({
      turn: input.turn,
      progress: input.progress,
      recordModelRouteEvent: observeContinuationRouteEvents(
        input.recordModelRouteEvent,
        input.observation,
      ),
      onFallbackSelected: input.onFallbackSelected,
    }),
    loadAttemptHistory: input.loadAttemptHistory,
    loadAcceptedResponse: input.loadAcceptedResponse,
    recordAcceptedResponse: input.recordAcceptedResponse,
  };
  if (!input.selection.enabled) return createModelRoutePort(common);
  if (!common.loadAttemptHistory || !common.loadAcceptedResponse ||
      !common.recordAcceptedResponse) {
    throw new TurnContinuationBudgetStorageError(input.turn.turnId);
  }
  return createModelRoutePort({
    ...common,
    loadAttemptHistory: common.loadAttemptHistory,
    loadAcceptedResponse: common.loadAcceptedResponse,
    recordAcceptedResponse: common.recordAcceptedResponse,
    continuationBudget: { limits: input.selection.limits },
  });
}

export function guidedContinuationPrompt(input: {
  enabled: boolean;
  policy: ReturnType<typeof guidedPolicy>;
  personaInstructions: string;
  responseLanguage: string;
  prompt: string;
}): { prompt: string; instructions: string } {
  if (!input.enabled) {
    return {
      prompt: input.prompt,
      instructions: guidedInstructions(
        input.policy,
        input.personaInstructions,
        input.responseLanguage,
      ),
    };
  }
  return {
    prompt: [
      guidedDynamicInstructions(
        input.policy,
        input.personaInstructions,
        input.responseLanguage,
      ),
      input.prompt,
    ].filter(Boolean).join("\n\n"),
    instructions: guidedStableInstructions(input.policy),
  };
}
