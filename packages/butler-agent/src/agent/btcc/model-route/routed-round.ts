import {
  ModelProviderRequestError,
} from "../../../integrations/providers/provider-errors.ts";
import type {
  ModelRoundPort,
  ModelRoundRequest,
  ModelRoundResult,
  PreparedModelRoundPort,
} from "../ports/model-round.ts";
import type { TurnContinuationBudgetLimits } from "../turn/contracts.ts";
import { sanitizeCompactReplayCarrierForAcceptance } from
  "../compact-replay/index.ts";
import {
  advanceModelRoute,
  currentModelRouteCandidate,
  routeAttemptKey,
} from "./identity.ts";
import { classifyModelRouteFailure } from "./failure-policy.ts";
import type {
  ModelRouteAttemptHistory,
  ModelRouteEventHandler,
  ModelRouteState,
} from "./contracts.ts";
import {
  ModelRouteDispatchLimitError,
  ModelRouteRecoveredFailureError,
} from "./contracts.ts";
import {
  modelRouteDispatchBudget,
  providerRouteRequest,
  requestEvidence,
} from "./route-request-policy.ts";

type ModelRoutePortCommon = {
  base: ModelRoundPort;
  turnId: string;
  route: ModelRouteState;
  onRouteEvent?: ModelRouteEventHandler;
  loadAcceptedResponse?: (input: {
    roundId: string;
    candidateIndex: number;
    modelRef: string;
  }) => Promise<ModelRoundResult | undefined>;
  loadAttemptHistory?: (input: {
    roundId: string;
    candidateIndex: number;
    modelRef: string;
  }) => Promise<ModelRouteAttemptHistory>;
  recordAcceptedResponse?: (input: {
    roundId: string;
    candidateIndex: number;
    transportAttempt: number;
    modelRef: string;
    continuationBudgetEnabled?: boolean;
    requestHash?: string;
    serializedRequestBytes?: number;
    durableResultRefCount?: number;
    result: ModelRoundResult;
  }) => Promise<void>;
};

type ModelRoutePortInput = ModelRoutePortCommon & (
  | {
    base: PreparedModelRoundPort;
    continuationBudget: { limits: TurnContinuationBudgetLimits };
    onRouteEvent: ModelRouteEventHandler;
    loadAcceptedResponse: NonNullable<ModelRoutePortCommon["loadAcceptedResponse"]>;
    loadAttemptHistory: NonNullable<ModelRoutePortCommon["loadAttemptHistory"]>;
    recordAcceptedResponse: NonNullable<ModelRoutePortCommon["recordAcceptedResponse"]>;
  }
  | { continuationBudget?: undefined }
);

export function createModelRoutePort(input: ModelRoutePortInput): ModelRoundPort {
  let route = input.route;
  let generatedRoundSequence = 0;
  return {
    async runRound(request: ModelRoundRequest): Promise<ModelRoundResult> {
      const roundId = request.roundId ??
        `${input.turnId}:round:${generatedRoundSequence++}`;
      let dispatchCount = 0;
      let transportAttempt = 1;
      let continuation = request.continuation;
      let loadedAttemptKey: string | undefined;
      let attemptHistory: ModelRouteAttemptHistory = emptyAttemptHistory();
      let lastProviderError: unknown;
      const dispatchBudget = modelRouteDispatchBudget(route);
      while (true) {
        const candidate = currentModelRouteCandidate(route);
        if (!candidate) throw new Error("model_route_exhausted");
        const routedRequest = providerRouteRequest({
          request,
          candidate,
          continuation,
          route,
          continuationBudgetEnabled: Boolean(input.continuationBudget),
        });
        const providerRequest = input.continuationBudget
          ? input.base.prepareRequest(routedRequest)
          : routedRequest;
        const attemptKey = routeAttemptKey(input.turnId, roundId, route);
        const accepted = await input.loadAcceptedResponse?.({
          roundId,
          candidateIndex: route.activeCursor,
          modelRef: candidate.modelRef,
        });
        if (accepted) return accepted;

        if (loadedAttemptKey !== attemptKey) {
          loadedAttemptKey = attemptKey;
          attemptHistory = await input.loadAttemptHistory?.({
            roundId,
            candidateIndex: route.activeCursor,
            modelRef: candidate.modelRef,
          }) ?? emptyAttemptHistory();
          const terminalAttempts = new Set([
            ...attemptHistory.failed,
            ...attemptHistory.succeeded,
            ...attemptHistory.abandoned,
          ]);
          for (const startedAttempt of [...attemptHistory.started].sort((a, b) => a - b)) {
            if (terminalAttempts.has(startedAttempt)) continue;
            await input.onRouteEvent?.({
              ...requestEvidence(providerRequest, input.continuationBudget),
              type: "model.attempt.abandoned_after_restart",
              roundId,
              candidateIndex: route.activeCursor,
              transportAttempt: startedAttempt,
              modelRef: candidate.modelRef,
            });
            attemptHistory = {
              ...attemptHistory,
              abandoned: [...attemptHistory.abandoned, startedAttempt],
            };
            terminalAttempts.add(startedAttempt);
          }
          transportAttempt = maxAttempt(attemptHistory) + 1;
          const latestFailure = latestFailureAtCurrentAttempt(attemptHistory);
          if (latestFailure?.disposition === "surface") {
            throw recoveredFailure(latestFailure);
          }
          if (latestFailure?.disposition === "advance") {
            const next = advanceModelRoute(route, attemptKey);
            route = await selectFallback(
              input,
              route,
              attemptKey,
              roundId,
              next,
              recoveredFailure(latestFailure),
            );
            continuation = undefined;
            loadedAttemptKey = undefined;
            continue;
          }
          if (transportAttempt > route.retryCeiling) {
            route = await selectFallback(
              input,
              route,
              attemptKey,
              roundId,
              undefined,
              lastProviderError,
            );
            continuation = undefined;
            loadedAttemptKey = undefined;
            continue;
          }
        }

        if (dispatchCount >= dispatchBudget) {
          throw new ModelRouteDispatchLimitError(dispatchBudget);
        }
        const startedResult = await input.onRouteEvent?.({
          ...requestEvidence(providerRequest, input.continuationBudget),
          type: "model.attempt.started",
          roundId,
          candidateIndex: route.activeCursor,
          transportAttempt,
          modelRef: candidate.modelRef,
        });
        if (startedResult && startedResult.status !== "recorded") {
          if (startedResult.status === "already_terminal") {
            // Never redispatch a closed physical slot. A history reader is
            // required to distinguish terminal success from terminal failure.
            if (!input.loadAttemptHistory) {
              throw new Error("model_route_terminal_slot_requires_recovery");
            }
            loadedAttemptKey = undefined;
            continue;
          }
          attemptHistory = {
            ...attemptHistory,
            abandoned: [...attemptHistory.abandoned, transportAttempt],
          };
          if (transportAttempt < route.retryCeiling) {
            transportAttempt += 1;
            continue;
          }
          route = await selectFallback(
            input,
            route,
            attemptKey,
            roundId,
            undefined,
            lastProviderError,
          );
          continuation = undefined;
          loadedAttemptKey = undefined;
          continue;
        }
        attemptHistory = {
          ...attemptHistory,
          started: [...attemptHistory.started, transportAttempt],
        };

        let result: ModelRoundResult;
        try {
          dispatchCount += 1;
          result = await input.base.runRound(providerRequest);
        } catch (error) {
          const disposition = classifyModelRouteFailure(error);
          const errorCode = error instanceof ModelProviderRequestError
            ? error.code
            : error instanceof ModelRouteDispatchLimitError
              ? error.code
              : "provider_unknown_error";
          await input.onRouteEvent?.({
            ...requestEvidence(providerRequest, input.continuationBudget),
            type: "model.attempt.failed",
            roundId,
            candidateIndex: route.activeCursor,
            transportAttempt,
            modelRef: candidate.modelRef,
            errorCode,
            failureDisposition: disposition,
          });
          if (disposition === "surface") throw error;
          lastProviderError = error;
          attemptHistory = {
            ...attemptHistory,
            failed: [...attemptHistory.failed, transportAttempt],
            failedDetails: [
              ...(attemptHistory.failedDetails ?? []),
              { transportAttempt, errorCode, disposition },
            ],
          };
          if (disposition === "retry" && transportAttempt < route.retryCeiling) {
            transportAttempt += 1;
            continue;
          }
          const next = advanceModelRoute(route, attemptKey);
          if (!next) throw error;
          route = await selectFallback(input, route, attemptKey, roundId, next);
          continuation = undefined;
          loadedAttemptKey = undefined;
          continue;
        }

        // Acceptance durability is intentionally outside the provider catch:
        // a storage fault never becomes a provider failure or fallback.
        const acceptedResult = sanitizeCompactReplayCarrierForAcceptance({
          request,
          result,
        });
        await input.recordAcceptedResponse?.({
          ...requestEvidence(providerRequest, input.continuationBudget),
          roundId,
          candidateIndex: route.activeCursor,
          transportAttempt,
          modelRef: candidate.modelRef,
          result: acceptedResult,
        });
        if (!input.recordAcceptedResponse) {
          await input.onRouteEvent?.({
            ...requestEvidence(providerRequest, input.continuationBudget),
            type: "model.attempt.succeeded",
            roundId,
            candidateIndex: route.activeCursor,
            transportAttempt,
            modelRef: candidate.modelRef,
          });
        }
        return acceptedResult;
      }

      // The loop either returns a provider result or throws a typed failure.
      // This guard only documents the impossible fallthrough for type narrowing.
      throw lastProviderError ?? new Error("model_route_exhausted");
    },
  };
}

async function selectFallback(
  input: ModelRoutePortInput,
  route: ModelRouteState,
  attemptKey: string,
  roundId: string,
  next = advanceModelRoute(route, attemptKey),
  exhaustionError?: unknown,
): Promise<ModelRouteState> {
  if (!next) {
    throw exhaustionError instanceof Error
      ? exhaustionError
      : new Error("model_route_exhausted_after_restart");
  }
  await input.onRouteEvent?.({
    type: "model.fallback.selected",
    roundId,
    candidateIndex: next.activeCursor,
    modelRef: currentModelRouteCandidate(next)!.modelRef,
    route: next,
  });
  return next;
}

function emptyAttemptHistory(): ModelRouteAttemptHistory {
  return { started: [], failed: [], succeeded: [], abandoned: [] };
}

function latestFailureAtCurrentAttempt(
  history: ModelRouteAttemptHistory,
): NonNullable<ModelRouteAttemptHistory["failedDetails"]>[number] | undefined {
  const details = [...(history.failedDetails ?? [])]
    .filter((detail) => history.failed.includes(detail.transportAttempt))
    .sort((a, b) => a.transportAttempt - b.transportAttempt);
  const latest = details.at(-1);
  if (!latest || latest.transportAttempt !== maxAttempt(history)) return undefined;
  return latest;
}

function recoveredFailure(
  detail: NonNullable<ModelRouteAttemptHistory["failedDetails"]>[number],
): ModelRouteRecoveredFailureError {
  return new ModelRouteRecoveredFailureError(
    detail.errorCode,
    detail.disposition,
  );
}

function maxAttempt(history: ModelRouteAttemptHistory): number {
  return Math.max(
    0,
    ...history.started,
    ...history.failed,
    ...(history.failedDetails ?? []).map((detail) => detail.transportAttempt),
    ...history.succeeded,
    ...history.abandoned,
  );
}
