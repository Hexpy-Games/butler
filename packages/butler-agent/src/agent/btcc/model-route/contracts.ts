import type { ReasoningEffort } from "../../../integrations/providers/runtime-contracts.ts";
import type { ModelRoundResult } from "../ports/model-round.ts";

export const MODEL_ROUTE_SCHEMA = "butler.model-route.v1" as const;
export const MODEL_ROUTE_MAX_CANDIDATES = 6;
export const MODEL_ROUTE_MAX_RETRY_ATTEMPTS = 5;
export const MODEL_ROUTE_DEFAULT_RETRY_ATTEMPTS = 3;
/** A single runRound can physically dispatch at most every candidate's retry ceiling. */
export const MODEL_ROUTE_MAX_DISPATCHES =
  MODEL_ROUTE_MAX_CANDIDATES * MODEL_ROUTE_MAX_RETRY_ATTEMPTS;

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

export type ModelRouteFailureRecord = {
  transportAttempt: number;
  errorCode: string;
  disposition: ModelRouteFailureDisposition;
};

export type ModelRouteAttemptHistory = {
  started: readonly number[];
  failed: readonly number[];
  /** Failure details are optional for compatibility with pre-disposition journals. */
  failedDetails?: readonly ModelRouteFailureRecord[];
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
  continuationBudgetEnabled?: boolean;
  /** Digest-only durable request identity used for no-progress recovery. */
  requestHash?: string;
  serializedRequestBytes?: number;
  durableResultRefCount?: number;
  errorCode?: string;
  failureDisposition?: ModelRouteFailureDisposition;
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
  continuationBudgetEnabled?: boolean;
  requestHash?: string;
  serializedRequestBytes?: number;
  durableResultRefCount?: number;
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
    cause?: unknown,
  ) {
    super(
      `BTCC model route durability failed during ${phase}`,
      cause === undefined ? undefined : { cause },
    );
    this.name = "ModelRouteDurabilityError";
  }
}

/** Safe recovery signal emitted when a persisted provider failure is terminal. */
export class ModelRouteRecoveredFailureError extends Error {
  readonly code = "model_route_recovered_failure" as const;

  constructor(
    readonly failureCode: string,
    readonly disposition: ModelRouteFailureDisposition,
  ) {
    super(`BTCC model route recovered ${failureCode} (${disposition})`);
    this.name = "ModelRouteRecoveredFailureError";
  }
}

/** Deterministic guard against a malformed runRound causing unbounded dispatch. */
export class ModelRouteDispatchLimitError extends Error {
  readonly code = "model_route_dispatch_limit_exceeded" as const;

  constructor(readonly maxDispatches: number) {
    super(`BTCC model route runRound dispatch limit exceeded (${maxDispatches})`);
    this.name = "ModelRouteDispatchLimitError";
  }
}

export function isModelRouteDurabilityError(
  error: unknown,
): error is ModelRouteDurabilityError {
  return error instanceof ModelRouteDurabilityError;
}
