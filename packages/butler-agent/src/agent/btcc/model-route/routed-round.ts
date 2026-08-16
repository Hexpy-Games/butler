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
import { attachAcceptedToolSurface, continuationForRoundContext, replayAcceptedToolSurface } from "./tool-surface-continuation.ts";
import { ModelRouteDispatchLimitError } from "./contracts.ts";
import {
  createModelRouteRecovery,
  normalizeModelRouteFailure,
} from "./recovery.ts";
import {
  modelRouteDispatchBudget,
  selectModelRouteFallback,
} from "./fallback-selection.ts";

export function createModelRoutePort(input: {
  base: ModelRoundPort;
  turnId: string;
  route: ModelRouteState;
  retryDelayMs?: (retryIndex: number) => number;
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
    ...(input.base.initialRequestBytes
      ? { initialRequestBytes: input.base.initialRequestBytes.bind(input.base) } : {}),
    ...(input.base.statelessMessageBytes ? {
      statelessMessageBytes: input.base.statelessMessageBytes.bind(input.base),
    } : {}),
    async runRound(request: ModelRoundRequest): Promise<ModelRoundResult> {
      const roundId = request.roundId ?? `${input.turnId}:round:${generatedRoundSequence++}`;
      let dispatchCount = 0;
      let transportAttempt = 1;
      let continuation = continuationForRoundContext(request);
      let loadedAttemptKey: string | undefined;
      let attemptHistory: ModelRouteAttemptHistory = emptyAttemptHistory();
      let lastProviderError: unknown;
      const dispatchBudget = modelRouteDispatchBudget(route);
      const recovery = createModelRouteRecovery({
        maxAttempts: route.retryCeiling,
        signal: request.signal,
        retryDelayMs: input.retryDelayMs,
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
        if (accepted) return replayAcceptedToolSurface(
          accepted, request.toolSurfaceDigest, {
            roundId, candidateIndex: route.activeCursor,
            transportAttempt: 0, modelRef: candidate.modelRef,
          });

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
            route = await selectModelRouteFallback({
              onRouteEvent: input.onRouteEvent,
              route,
              attemptKey,
              roundId,
              next,
              exhaustionError: recoveredFailure(latestFailure),
              imageCarrier: request.imageCarrier,
            });
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
            route = await selectModelRouteFallback({
              onRouteEvent: input.onRouteEvent,
              route,
              attemptKey,
              roundId,
              next,
              exhaustionError: exhaustion,
              imageCarrier: request.imageCarrier,
            });
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
          route = await selectModelRouteFallback({
            onRouteEvent: input.onRouteEvent,
            route,
            attemptKey,
            roundId,
            exhaustionError: lastProviderError,
            imageCarrier: request.imageCarrier,
          });
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
            routeContext: {
              schemaVersion: "butler.model-route-request.v1",
              routeDigest: route.routeDigest,
              cursor: route.activeCursor, modelRef: candidate.modelRef,
              ...(request.toolSurfaceDigest ? { toolSurfaceDigest: request.toolSurfaceDigest } : {}),
            },
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
          route = await selectModelRouteFallback({
            onRouteEvent: input.onRouteEvent,
            route,
            attemptKey,
            roundId,
            next,
            imageCarrier: request.imageCarrier,
          });
          continuation = undefined;
          loadedAttemptKey = undefined;
          continue;
        }
        result = attachAcceptedToolSurface(result, request.toolSurfaceDigest);
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
        return input.recordAcceptedResponse ? {
          ...result,
          acceptedCheckpoint: {
            roundId, candidateIndex: route.activeCursor,
            transportAttempt, modelRef: candidate.modelRef,
          },
        } : result;
      }

      throw lastProviderError ?? new Error("model_route_exhausted");
    },
  };
}
