import type { BtccTurnProgressObserver } from "../contracts.ts";
import type {
  ModelRouteEvent,
  ModelRouteEventResult,
} from "../model-route/index.ts";

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
