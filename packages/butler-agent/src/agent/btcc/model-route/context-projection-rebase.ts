import type {
  ContextProjectionRebaseIdentity,
  ModelRoundRequest,
} from "../ports/model-round.ts";
import { PhaseContinuityProjectionError } from "../ports/model-round.ts";

export function continuationForContextProjection(
  request: Pick<ModelRoundRequest, "boundedContinuation" | "continuation">,
): unknown {
  return request.boundedContinuation
    ? continuationAfterContextProjectionRebase({
        current: request.boundedContinuation.contextProjection,
        continuation: request.continuation,
      })
    : request.continuation;
}

export function continuationAfterContextProjectionRebase(input: {
  current: ContextProjectionRebaseIdentity | undefined;
  continuation: unknown;
}): unknown {
  // An absent identity is the exact-history path, not a projection change.
  if (!input.current) return input.continuation;
  const accepted = continuationProjectionIdentity(input.continuation);
  return JSON.stringify(input.current) === JSON.stringify(accepted ?? null)
    ? input.continuation
    : undefined;
}

function continuationProjectionIdentity(
  continuation: unknown,
): ContextProjectionRebaseIdentity | undefined {
  if (!continuation || typeof continuation !== "object" || Array.isArray(continuation)) {
    return undefined;
  }
  const value = (continuation as Record<string, unknown>).contextProjection;
  if (value === undefined) return undefined;
  return parseProjectionIdentity(value);
}

function parseProjectionIdentity(value: unknown): ContextProjectionRebaseIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PhaseContinuityProjectionError(
      "phase_continuity_projection_rebase_identity_invalid",
    );
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set([
    "schemaVersion", "projectionRevision", "projectionDigest", "projectedThroughOrdinal",
  ]);
  if (Object.keys(record).some((key) => !allowed.has(key)) ||
      record.schemaVersion !== "butler.context-projection-rebase.v1" ||
      record.projectionRevision !== "butler.phase-continuity-projection.v1" ||
      typeof record.projectionDigest !== "string" ||
      !/^[a-f0-9]{64}$/u.test(record.projectionDigest) ||
      !Number.isSafeInteger(record.projectedThroughOrdinal) ||
      Number(record.projectedThroughOrdinal) < 0 ||
      Number(record.projectedThroughOrdinal) > 1_000_000) {
    throw new PhaseContinuityProjectionError(
      "phase_continuity_projection_rebase_identity_invalid",
    );
  }
  return record as unknown as ContextProjectionRebaseIdentity;
}
