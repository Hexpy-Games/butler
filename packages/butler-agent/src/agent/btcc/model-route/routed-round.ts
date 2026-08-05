import {
  ModelProviderRequestError,
} from "../../../integrations/providers/provider-errors.ts";
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
import { classifyModelRouteFailure } from "./failure-policy.ts";
import type {
  ModelRouteAttemptHistory,
  ModelRouteEventHandler,
  ModelRouteState,
} from "./contracts.ts";

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
}): ModelRoundPort {
  let route = input.route;
  let generatedRoundSequence = 0;
  return {
    async runRound(request: ModelRoundRequest): Promise<ModelRoundResult> {
      const roundId = request.roundId ??
        `${input.turnId}:round:${generatedRoundSequence++}`;
      let transportAttempt = 1;
      let continuation = request.continuation;
      let loadedAttemptKey: string | undefined;
      let attemptHistory: ModelRouteAttemptHistory = emptyAttemptHistory();
      let lastProviderError: unknown;
      while (true) {
        const candidate = currentModelRouteCandidate(route);
        if (!candidate) throw new Error("model_route_exhausted");
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
          await input.onRouteEvent?.({
            type: "model.attempt.failed",
            roundId,
            candidateIndex: route.activeCursor,
            transportAttempt,
            modelRef: candidate.modelRef,
            errorCode: error instanceof ModelProviderRequestError
              ? error.code
              : "provider_unknown_error",
          });
          const disposition = classifyModelRouteFailure(error);
          if (disposition === "surface") throw error;
          lastProviderError = error;
          attemptHistory = {
            ...attemptHistory,
            failed: [...attemptHistory.failed, transportAttempt],
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
        return result;
      }

      // The loop either returns a provider result or throws a typed failure.
      // This guard only documents the impossible fallthrough for type narrowing.
      throw lastProviderError ?? new Error("model_route_exhausted");
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

function maxAttempt(history: ModelRouteAttemptHistory): number {
  return Math.max(
    0,
    ...history.started,
    ...history.failed,
    ...history.succeeded,
    ...history.abandoned,
  );
}
