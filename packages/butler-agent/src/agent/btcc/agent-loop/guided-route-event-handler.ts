import type { BtccTurnProgressObserver } from "../contracts.ts";
import type {
  ModelRouteEvent,
  ModelRouteEventResult,
} from "../model-route/index.ts";
import type { TurnRecord } from "../turn/index.ts";

export function createGuidedRouteEventHandler(input: {
  turn: TurnRecord;
  progress?: BtccTurnProgressObserver;
  record?: (event: ModelRouteEvent) => Promise<ModelRouteEventResult | void>;
  selectModel(modelRef: string): void;
}): (event: ModelRouteEvent) => Promise<ModelRouteEventResult | void> {
  let pendingFallback: { roundId: string; modelRef: string } | undefined;
  return async (event) => {
    const persisted = await input.record?.(event);
    if (
      event.type === "model.attempt.started" &&
      pendingFallback?.roundId === event.roundId &&
      pendingFallback.modelRef === event.modelRef
    ) {
      pendingFallback = undefined;
      try {
        await input.progress?.modelRoundWaitingChanged?.({
          turnId: input.turn.turnId,
          requestId: event.roundId,
          status: "started",
          modelRef: event.modelRef,
        });
      } catch {
        // Public model identity cannot veto the provider dispatch.
      }
    }
    if (event.type === "model.fallback.selected") {
      input.selectModel(event.modelRef);
      pendingFallback = { roundId: event.roundId, modelRef: event.modelRef };
      try {
        await input.progress?.phaseActivityChanged?.({
          turnId: input.turn.turnId,
          semanticState: input.turn.semanticState,
          activityId: `${input.turn.turnId}:model-fallback:${event.roundId}:${event.candidateIndex}`,
          title: "대체 모델 경로 선택",
          summary: `${event.modelRef} 모델로 계속 진행합니다.`,
          modelRef: event.modelRef,
        });
      } catch {
        // Public fallback notice cannot veto the next provider dispatch.
      }
    }
    return persisted;
  };
}
