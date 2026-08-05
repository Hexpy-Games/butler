import { createHash } from "node:crypto";
import {
  modelIdentityKey,
  resolveModelMetadata,
  type ReasoningEffort,
} from "../../../integrations/providers/model-catalog.ts";
import {
  MODEL_ROUTE_DEFAULT_RETRY_ATTEMPTS,
  MODEL_ROUTE_MAX_CANDIDATES,
  MODEL_ROUTE_MAX_RETRY_ATTEMPTS,
  MODEL_ROUTE_SCHEMA,
  type ModelRouteCandidate,
  type ModelRouteState,
} from "./contracts.ts";

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
  const candidates = refs.map(({ modelRef, metadata }): ModelRouteCandidate => ({
    modelRef,
    reasoningEffort: metadata.reasoning_efforts.includes(input.reasoningEffort)
      ? input.reasoningEffort
      : metadata.default_reasoning_effort,
  }));
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

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
