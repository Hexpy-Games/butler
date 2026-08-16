import { ImageAdmissionError } from "../../image-attachment/index.ts";
import type { ModelRoundRequest } from "../ports/model-round.ts";
import {
  MODEL_ROUTE_MAX_CANDIDATES,
  MODEL_ROUTE_MAX_DISPATCHES,
  MODEL_ROUTE_MAX_RETRY_ATTEMPTS,
  type ModelRouteEventHandler,
  type ModelRouteState,
} from "./contracts.ts";
import { advanceModelRoute, currentModelRouteCandidate } from "./identity.ts";

export async function selectModelRouteFallback(input: {
  onRouteEvent?: ModelRouteEventHandler;
  route: ModelRouteState;
  attemptKey: string;
  roundId: string;
  next?: ModelRouteState;
  exhaustionError?: unknown;
  imageCarrier?: ModelRoundRequest["imageCarrier"];
}): Promise<ModelRouteState> {
  const next = input.next ?? advanceModelRoute(input.route, input.attemptKey);
  if (!next) {
    throw input.exhaustionError instanceof Error
      ? input.exhaustionError
      : new Error("model_route_exhausted_after_restart");
  }
  if (input.imageCarrier) {
    const candidate = currentModelRouteCandidate(next);
    const frozenModelRef = `${input.imageCarrier.providerId}/${input.imageCarrier.modelId}`;
    if (!candidate || candidate.modelRef !== frozenModelRef) {
      throw new ImageAdmissionError("image_model_unsupported", "visual_fallback_disabled");
    }
  }
  await input.onRouteEvent?.({
    type: "model.fallback.selected",
    roundId: input.roundId,
    candidateIndex: next.activeCursor,
    modelRef: currentModelRouteCandidate(next)!.modelRef,
    route: next,
  });
  return next;
}

export function modelRouteDispatchBudget(route: ModelRouteState): number {
  const retryCeiling = Math.min(
    MODEL_ROUTE_MAX_RETRY_ATTEMPTS,
    Math.max(1, Math.trunc(route.retryCeiling)),
  );
  const candidateCount = Math.min(
    MODEL_ROUTE_MAX_CANDIDATES,
    Math.max(0, route.candidates.length),
  );
  return Math.min(MODEL_ROUTE_MAX_DISPATCHES, retryCeiling * candidateCount);
}
