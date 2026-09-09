import type { ModelRoundRequest, ModelRoundResult } from "../ports/model-round.ts";
import { RoundToolSurfaceError } from "../ports/model-round.ts";
import { continuationForContextProjection } from "./context-projection-rebase.ts";

export function continuationForRoundContext(request: ModelRoundRequest): unknown {
  return continuationForContextProjection(request);
}

export function attachAcceptedToolSurface(
  result: ModelRoundResult,
  digest: string | undefined,
): ModelRoundResult {
  const normalized = normalizeDigest(digest);
  if (!normalized) return result;
  if (result.continuation === undefined) return result;
  if (!isRecord(result.continuation)) {
    throw new RoundToolSurfaceError("round_tool_surface_continuation_invalid");
  }
  return {
    ...result,
    continuation: {
      ...result.continuation,
      toolSurfaceDigest: normalized,
    },
  };
}

export function replayAcceptedResponse(
  result: ModelRoundResult,
  checkpoint: NonNullable<ModelRoundResult["acceptedCheckpoint"]>,
): ModelRoundResult {
  return {
    ...result,
    acceptedCheckpoint: result.acceptedCheckpoint ?? checkpoint,
  };
}

function normalizeDigest(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new RoundToolSurfaceError("round_tool_surface_continuation_invalid");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
