import {
  modelRoundRequestDigest,
  modelRoundRequestSerializedBytes,
  type ModelRoundRequest,
} from "../ports/model-round.ts";
import type { TurnContinuationBudgetLimits } from "../turn/contracts.ts";
import type { ModelRouteState } from "./contracts.ts";
import type { ModelRouteCandidate } from "./contracts.ts";
import {
  MODEL_ROUTE_MAX_CANDIDATES,
  MODEL_ROUTE_MAX_DISPATCHES,
  MODEL_ROUTE_MAX_RETRY_ATTEMPTS,
} from "./contracts.ts";

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

export function requestEvidence(
  request: ModelRoundRequest,
  continuationBudget: { limits: TurnContinuationBudgetLimits } | undefined,
): {
  continuationBudgetEnabled?: true;
  requestHash?: string;
  serializedRequestBytes?: number;
} {
  if (!continuationBudget) return {};
  return {
    continuationBudgetEnabled: true,
    requestHash: modelRoundRequestDigest(request),
    serializedRequestBytes: modelRoundRequestSerializedBytes(request),
  };
}

export function providerRouteRequest(input: {
  request: ModelRoundRequest;
  candidate: ModelRouteCandidate;
  continuation: unknown;
  route: ModelRouteState;
  continuationBudgetEnabled: boolean;
}): ModelRoundRequest {
  return {
    ...input.request,
    model: input.candidate.modelRef,
    reasoningEffort: input.candidate.reasoningEffort,
    ...(input.request.usageAttribution
      ? {
          usageAttribution: {
            ...input.request.usageAttribution,
            reasoningEffort: input.candidate.reasoningEffort,
          },
        }
      : {}),
    providerRetryAttempts: 1,
    continuation: input.continuation,
    ...(input.continuationBudgetEnabled && input.request.cacheScope
      ? {
          cacheScope: `${input.request.cacheScope}:route:${input.route.routeDigest}:${input.route.activeCursor}`,
        }
      : {}),
  };
}
