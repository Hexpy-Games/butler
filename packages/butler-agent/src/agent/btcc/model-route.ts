import { createHash } from "node:crypto";
import { modelIdentityKey, resolveModelMetadata, type ReasoningEffort } from "../../integrations/providers/model-catalog.ts";
import { ModelProviderRequestError } from "../../integrations/providers/provider-errors.ts";
import type { ModelRoundPort, ModelRoundRequest, ModelRoundResult } from "./ports/model-round.ts";

export const MODEL_ROUTE_SCHEMA = "butler.model-route.v1" as const;
export const MODEL_ROUTE_MAX_CANDIDATES = 6;
export const MODEL_ROUTE_MAX_RETRY_ATTEMPTS = 5;
export const MODEL_ROUTE_DEFAULT_RETRY_ATTEMPTS = 3;

export type ModelRouteCandidate = {
  modelRef: string;
  reasoningEffort: ReasoningEffort;
};

export type ModelRouteState = {
  schemaVersion: typeof MODEL_ROUTE_SCHEMA;
  routeDigest: string;
  candidates: readonly ModelRouteCandidate[];
  retryCeiling: number;
  catalogGeneration: string;
  activeCursor: number;
  consumedAttempts: readonly string[];
};

export type ModelRouteFailureDisposition =
  | "retry"
  | "advance"
  | "surface";

export type ModelRouteAttemptHistory = {
  started: readonly number[];
  failed: readonly number[];
  succeeded: readonly number[];
  abandoned: readonly number[];
};

export type ModelRouteEventResult = {
  status: "recorded" | "abandoned_after_restart" | "already_terminal";
};

export type ModelRouteEvent = {
  type: "model.attempt.started" | "model.attempt.succeeded" | "model.attempt.failed" |
    "model.attempt.abandoned_after_restart" | "model.fallback.selected";
  roundId: string;
  candidateIndex: number;
  transportAttempt?: number;
  modelRef: string;
  errorCode?: string;
  route?: ModelRouteState;
};

export function buildModelRoute(input: {
  primaryModelRef: string;
  backupModelRefs?: readonly string[];
  reasoningEffort: ReasoningEffort;
  catalogGeneration?: string;
  retryCeiling?: number;
}): ModelRouteState {
  const refs = [input.primaryModelRef, ...(input.backupModelRefs ?? [])]
    .map((modelRef) => modelRef.trim())
    .filter(Boolean)
    .map((modelRef) => ({ modelRef, metadata: resolveModelMetadata(modelRef) }))
    .filter((candidate, index, all) => all.findIndex((item) =>
      modelIdentityKey(item.metadata) === modelIdentityKey(candidate.metadata)) === index)
    .slice(0, MODEL_ROUTE_MAX_CANDIDATES);
  const candidates = refs.map(({ modelRef, metadata }) => {
    return {
      modelRef,
      reasoningEffort: metadata.reasoning_efforts.includes(input.reasoningEffort)
        ? input.reasoningEffort
        : metadata.default_reasoning_effort,
    };
  });
  const retryCeiling = clampRetryAttempts(input.retryCeiling);
  const routeBody = {
    schemaVersion: MODEL_ROUTE_SCHEMA,
    candidates,
    retryCeiling,
    catalogGeneration: input.catalogGeneration?.trim() || "unknown",
  };
  return {
    ...routeBody,
    routeDigest: digest(routeBody),
    activeCursor: 0,
    consumedAttempts: [],
  };
}

export function clampRetryAttempts(value: unknown): number {
  const candidate = Number(value);
  if (!Number.isFinite(candidate)) return MODEL_ROUTE_DEFAULT_RETRY_ATTEMPTS;
  return Math.min(
    MODEL_ROUTE_MAX_RETRY_ATTEMPTS,
    Math.max(1, Math.trunc(candidate)),
  );
}

export function currentModelRouteCandidate(
  route: ModelRouteState,
): ModelRouteCandidate | undefined {
  return route.candidates[route.activeCursor];
}

export function classifyModelRouteFailure(
  error: unknown,
): ModelRouteFailureDisposition {
  if (!(error instanceof ModelProviderRequestError)) return "surface";
  if (error.code === "provider_auth_error" ||
      error.code === "admission_invariant_violation" ||
      error.code === "provider_context_limit_exceeded" ||
      error.code === "provider_invalid_request" ||
      error.code === "provider_permission_error" ||
      error.code === "provider_safety_error") {
    return "surface";
  }
  if (error.code === "provider_protocol_error") return "retry";
  if (error.statusCode === 400 || error.statusCode === 409 || error.statusCode === 422) {
    return "surface";
  }
  if (error.statusCode === 402 || error.statusCode === 404 || error.statusCode === 410) {
    return "advance";
  }
  if (error.statusCode === 429) {
    const cause = error.causeMessage?.toLocaleLowerCase("en-US") ?? "";
    return /(?:insufficient[_ -]?quota|credit|billing|payment)/u.test(cause)
      ? "advance"
      : "retry";
  }
  if ((error.statusCode ?? 0) >= 500) return "retry";
  if (error.retryable) return "retry";
  return "advance";
}

export function advanceModelRoute(
  route: ModelRouteState,
  attemptKey: string,
): ModelRouteState | undefined {
  if (route.activeCursor >= route.candidates.length - 1) return undefined;
  return {
    ...route,
    activeCursor: route.activeCursor + 1,
    consumedAttempts: [...new Set([...route.consumedAttempts, attemptKey])],
  };
}

export function routeAttemptKey(
  turnId: string,
  roundId: string,
  route: ModelRouteState,
): string {
  return `${turnId}:${roundId}:${route.activeCursor}:${currentModelRouteCandidate(route)?.modelRef ?? "unknown"}`;
}

export function createModelRoutePort(input: {
  base: ModelRoundPort;
  turnId: string;
  route: ModelRouteState;
  onRouteEvent?: (event: ModelRouteEvent) =>
    ModelRouteEventResult | void | Promise<ModelRouteEventResult | void>;
  onRouteChange?: (route: ModelRouteState) => void | Promise<void>;
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
            const next = advanceModelRoute(route, attemptKey);
            if (!next) throw lastProviderError ?? new Error("model_route_exhausted_after_restart");
            route = next;
            continuation = undefined;
            loadedAttemptKey = undefined;
            await input.onRouteEvent?.({
              type: "model.fallback.selected",
              roundId,
              candidateIndex: route.activeCursor,
              modelRef: currentModelRouteCandidate(route)!.modelRef,
              route,
            });
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
            // A concurrent/recovery writer already closed this physical slot.
            // Reload durable history before choosing the next slot so a failed
            // terminal advances to its next attempt without redispatching it.
            // Without a history reader we cannot distinguish a terminal
            // success (which must be replayed) from a terminal failure (which
            // may advance).  Surface the recovery gap rather than ever
            // redispatching an already-closed physical slot.
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
          const next = advanceModelRoute(route, attemptKey);
          if (!next) throw lastProviderError ?? new Error("model_route_exhausted_after_restart");
          route = next;
          continuation = undefined;
          loadedAttemptKey = undefined;
          await input.onRouteEvent?.({
            type: "model.fallback.selected",
            roundId,
            candidateIndex: route.activeCursor,
            modelRef: currentModelRouteCandidate(route)!.modelRef,
            route,
          });
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
          // Only a provider transport/request failure is eligible for retry or
          // fallback. Persistence of an already accepted response is a
          // separate durability failure and must never be misclassified as a
          // provider failure.
          await input.onRouteEvent?.({
            type: "model.attempt.failed",
            roundId,
            candidateIndex: route.activeCursor,
            transportAttempt,
            modelRef: candidate.modelRef,
            errorCode: error instanceof ModelProviderRequestError ? error.code : "provider_unknown_error",
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
          route = next;
          continuation = undefined;
          loadedAttemptKey = undefined;
          await input.onRouteEvent?.({
            type: "model.fallback.selected",
            roundId,
            candidateIndex: route.activeCursor,
            modelRef: currentModelRouteCandidate(route)!.modelRef,
            route,
          });
          continue;
        }

        // This is deliberately outside the provider try/catch. A response
        // has already been accepted at the provider boundary; failure to
        // persist its acceptance must surface as a durability error and must
        // not consume another provider attempt or select a fallback.
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
    },
  };
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

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
