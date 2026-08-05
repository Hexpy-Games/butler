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
