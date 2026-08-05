import type { ReasoningEffort } from "../../../integrations/providers/runtime-contracts.ts";
import type { ModelRoundResult } from "../ports/model-round.ts";

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

export type ModelRouteFailureDisposition = "retry" | "advance" | "surface";

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

export type ModelRouteEventHandler = (
  event: ModelRouteEvent,
) => ModelRouteEventResult | void | Promise<ModelRouteEventResult | void>;

export type ModelRouteAcceptance = {
  roundId: string;
  candidateIndex: number;
  transportAttempt: number;
  modelRef: string;
  result: ModelRoundResult;
};

export type ModelRouteDurabilityPhase =
  | "attempt_history_read"
  | "attempt_event_write"
  | "response_acceptance_read"
  | "response_acceptance_write";

/**
 * A route journal/checkpoint failure is an execution-integrity failure, not a
 * provider failure. It must escape the operational response fallback so the
 * queue can preserve the admitted Turn for ownership recovery.
 */
export class ModelRouteDurabilityError extends Error {
  readonly code = "model_route_durability_failure" as const;

  constructor(
    readonly phase: ModelRouteDurabilityPhase,
  ) {
    super(`BTCC model route durability failed during ${phase}`);
    this.name = "ModelRouteDurabilityError";
  }
}

export function isModelRouteDurabilityError(
  error: unknown,
): error is ModelRouteDurabilityError {
  return error instanceof ModelRouteDurabilityError;
}
