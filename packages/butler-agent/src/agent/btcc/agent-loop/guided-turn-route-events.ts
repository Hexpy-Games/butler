import type { BtccTurnProgressObserver } from "../contracts.ts";
import type { TurnRecord } from "../turn/index.ts";
import type {
  ModelRouteEvent,
  ModelRouteEventResult,
} from "../model-route/index.ts";

export function createGuidedRouteEventHandler(input: {
  turn: Pick<TurnRecord, "turnId" | "semanticState">;
  progress?: BtccTurnProgressObserver;
  recordModelRouteEvent?: (event: ModelRouteEvent) =>
    Promise<ModelRouteEventResult | void>;
  onFallbackSelected: (event: ModelRouteEvent) => void;
}): (event: ModelRouteEvent) => Promise<ModelRouteEventResult | void> {
  let pendingFallbackProjection: { roundId: string; modelRef: string } | undefined;
  return async (event) => {
    const persisted = await input.recordModelRouteEvent?.(event);
    if (
      event.type === "model.attempt.started" &&
      pendingFallbackProjection?.roundId === event.roundId &&
      pendingFallbackProjection.modelRef === event.modelRef
    ) {
      pendingFallbackProjection = undefined;
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
      input.onFallbackSelected(event);
      pendingFallbackProjection = {
        roundId: event.roundId,
        modelRef: event.modelRef,
      };
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
