import { ImageAdmissionError } from "../../image-attachment/index.ts";
import type {
  ModelRoundPort,
  ModelRoundRequest,
  ModelRoundResult,
} from "../ports/model-round.ts";
import {
  advanceModelRoute,
  currentModelRouteCandidate,
  routeAttemptKey,
} from "./identity.ts";
import {
  emptyAttemptHistory,
  latestFailureAtCurrentAttempt,
  maxAttempt,
  recoveredFailure,
} from "./history.ts";
import type {
  ModelRouteAttemptHistory,
  ModelRouteEventHandler,
  ModelRouteState,
} from "./contracts.ts";
import {
  MODEL_ROUTE_MAX_CANDIDATES,
  MODEL_ROUTE_MAX_DISPATCHES,
  MODEL_ROUTE_MAX_RETRY_ATTEMPTS,
  ModelRouteDispatchLimitError,
} from "./contracts.ts";
import {
  createModelRouteRecovery,
  normalizeModelRouteFailure,
} from "./recovery.ts";

export function createModelRoutePort(input: {
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
    result: ModelRoundResult;
  }) => Promise<void>;
  onRecoveryChanged?: Parameters<typeof createModelRouteRecovery>[0]["onChanged"];
}): ModelRoundPort {
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
      const recovery = createModelRouteRecovery({
        maxAttempts: route.retryCeiling,
        signal: request.signal,
        onChanged: input.onRecoveryChanged,
      });
      const frozenVisualModelRef = request.imageCarrier
        ? `${request.imageCarrier.providerId}/${request.imageCarrier.modelId}`
        : undefined;
      while (true) {
        const candidate = currentModelRouteCandidate(route);
        if (!candidate) throw new Error("model_route_exhausted");
        if (frozenVisualModelRef && candidate.modelRef !== frozenVisualModelRef) {
          throw new ImageAdmissionError("image_model_unsupported", "visual_fallback_disabled");
        }
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
            const next = request.imageCarrier ? undefined : advanceModelRoute(route, attemptKey);
            route = await selectFallback(
              input,
              route,
              attemptKey,
              roundId,
              next,
              recoveredFailure(latestFailure),
              request.imageCarrier,
            );
            continuation = undefined;
            loadedAttemptKey = undefined;
            continue;
          }
          if (
            latestFailure?.disposition === "retry" &&
            transportAttempt <= route.retryCeiling
          ) {
            await recovery.wait(
              transportAttempt - 1,
              candidate.modelRef,
              latestFailure.errorCode,
            );
          }
          if (transportAttempt > route.retryCeiling) {
            const exhaustion = latestFailure
              ? recoveredFailure(latestFailure)
              : lastProviderError;
            const next = advanceModelRoute(route, attemptKey);
            if (latestFailure?.disposition === "retry" && !next) {
              await recovery.interrupt(
                route.retryCeiling,
                candidate.modelRef,
                latestFailure.errorCode,
              );
            }
            route = await selectFallback(
              input,
              route,
              attemptKey,
              roundId,
              next,
              exhaustion,
              request.imageCarrier,
            );
            continuation = undefined;
            loadedAttemptKey = undefined;
            continue;
          }
        }

        const startedResult = await input.onRouteEvent?.({
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
            request.imageCarrier,
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
          if (dispatchCount >= dispatchBudget) {
            throw new ModelRouteDispatchLimitError(dispatchBudget);
          }
          dispatchCount += 1;
          result = await input.base.runRound({
            ...request,
            model: candidate.modelRef,
            reasoningEffort: candidate.reasoningEffort,
            ...(request.usageAttribution
              ? {
                  usageAttribution: {
                    ...request.usageAttribution,
                    reasoningEffort: candidate.reasoningEffort,
                  },
                }
              : {}),
            providerRetryAttempts: 1,
            continuation,
          });
        } catch (error) {
          const failure = normalizeModelRouteFailure(error);
          const { disposition, errorCode } = failure;
          await input.onRouteEvent?.({
            type: "model.attempt.failed",
            roundId,
            candidateIndex: route.activeCursor,
            transportAttempt,
            modelRef: candidate.modelRef,
            errorCode,
            failureDisposition: disposition,
          });
          if (disposition === "surface") throw failure.error;
          lastProviderError = failure.error;
          attemptHistory = {
            ...attemptHistory,
            failed: [...attemptHistory.failed, transportAttempt],
            failedDetails: [
              ...(attemptHistory.failedDetails ?? []),
              { transportAttempt, errorCode, disposition },
            ],
          };
          if (disposition === "retry" && transportAttempt < route.retryCeiling) {
            await recovery.wait(transportAttempt, candidate.modelRef, errorCode);
            transportAttempt += 1;
            continue;
          }
          const next = request.imageCarrier ? undefined : advanceModelRoute(route, attemptKey);
          if (!next) {
            if (disposition === "retry") {
              await recovery.interrupt(transportAttempt, candidate.modelRef, errorCode);
            }
            throw failure.error;
          }
          await recovery.clear(transportAttempt, candidate.modelRef, errorCode);
          route = await selectFallback(input, route, attemptKey, roundId, next, undefined, request.imageCarrier);
          continuation = undefined;
          loadedAttemptKey = undefined;
          continue;
        }

        // Acceptance durability is intentionally outside the provider catch:
        // a storage fault never becomes a provider failure or fallback.
        await input.recordAcceptedResponse?.({
          roundId,
          candidateIndex: route.activeCursor,
          transportAttempt,
          modelRef: candidate.modelRef,
          result,
        });
        if (!input.recordAcceptedResponse) {
          await input.onRouteEvent?.({
            type: "model.attempt.succeeded",
            roundId,
            candidateIndex: route.activeCursor,
            transportAttempt,
            modelRef: candidate.modelRef,
          });
        }
        await recovery.clear(transportAttempt, candidate.modelRef);
        return result;
      }

    },
  };
}

async function selectFallback(
  input: Parameters<typeof createModelRoutePort>[0],
  route: ModelRouteState,
  attemptKey: string,
  roundId: string,
  next = advanceModelRoute(route, attemptKey),
  exhaustionError?: unknown,
  imageCarrier?: ModelRoundRequest["imageCarrier"],
): Promise<ModelRouteState> {
  if (!next) {
    throw exhaustionError instanceof Error
      ? exhaustionError
      : new Error("model_route_exhausted_after_restart");
  }
  if (imageCarrier) {
    const candidate = currentModelRouteCandidate(next);
    if (!candidate || candidate.modelRef !== `${imageCarrier.providerId}/${imageCarrier.modelId}`) {
      throw new ImageAdmissionError("image_model_unsupported", "visual_fallback_disabled");
    }
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

function modelRouteDispatchBudget(route: ModelRouteState): number {
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
