import {
  OperationRejectedError,
  rejectedOperationResult,
  type ObservationResult,
  type OperationExecutor,
} from "../../core/index.ts";
import {
  isResultReadRequest,
  type OperationResultStore,
} from "../../operation-result/index.ts";
import { SqliteOperationResultStore } from "../operation-result/index.ts";
import { ArtifactStore } from "./artifact-store.ts";
import { ProductionArtifactWorkspaceRuntime } from "./artifact-workspace-runtime.ts";
import type {
  ProductionOperationRuntime,
  ProductionOperationRuntimeOptions,
} from "./contracts.ts";
import { performObservation } from "./perform-observation.ts";
import { performPromotion } from "./perform-promotion.ts";
import { performReviewValidation } from "./perform-review-validation.ts";
import { performExternalEffect } from "./perform-external-effect.ts";
import { performWorkspaceAction } from "./perform-workspace-action.ts";
import type { WorkspaceActionBoundary } from "./perform-workspace-action.ts";
import { performWorkspaceObservation } from "./perform-workspace-observation.ts";

export type OperationRuntimeBoundary = WorkspaceActionBoundary | "before_result_persist";

export function createProductionOperationRuntime(
  options: ProductionOperationRuntimeOptions,
): ProductionOperationRuntime {
  const store = new ArtifactStore(options.butlerData);
  const results = new SqliteOperationResultStore(options.butlerData);
  return {
    artifacts: new ProductionArtifactWorkspaceRuntime(options, store),
    operations: createOperationExecutor(options, store, undefined, results),
  };
}

export function createOperationExecutor(
  options: ProductionOperationRuntimeOptions,
  store: ArtifactStore,
  afterWorkspaceBoundary?: (boundary: OperationRuntimeBoundary) => void,
  resultStore: OperationResultStore = new SqliteOperationResultStore(options.butlerData),
): OperationExecutor {
  return {
    async perform(input) {
      if (isResultReadRequest(input.request)) {
        try {
          return await resultStore.read({
            request: input.request,
            modelSelection: input.envelope.modelSelection,
          });
        } catch (error) {
          if (isAbortError(error) || input.signal?.aborted) throw error;
          return resultStore.record({
            binding: input.envelope.binding,
            request: input.request,
            result: rejectedOperationResult(
              input.request,
              new OperationRejectedError(
                "operation_result_read_invalid",
                error instanceof Error
                  ? error.message
                  : "The requested result selector could not be resolved.",
              ),
            ),
            modelSelection: input.envelope.modelSelection,
          });
        }
      }
      const existing = await resultStore.find({
        binding: input.envelope.binding,
        request: input.request,
        modelSelection: input.envelope.modelSelection,
      });
      if (existing) return existing;
      const result = await performOperation(input, options, store, afterWorkspaceBoundary).catch((error: unknown) => {
        if (error instanceof OperationRejectedError) {
          return rejectedOperationResult(input.request, error);
        }
        if (isAbortError(error) || input.signal?.aborted) throw error;
        if (
          input.request.kind !== "observe" &&
          input.request.kind !== "workspace_artifact_observation"
        ) throw error;
        return rejectedOperationResult(
          input.request,
          new OperationRejectedError(
            "capability_execution_failed",
            error instanceof Error ? error.message : "The capability could not execute its input.",
          ),
        );
      });
      if (input.request.kind === "workspace_artifact_action") {
        afterWorkspaceBoundary?.("before_result_persist");
      }
      const projection = await resultStore.record({
        binding: input.envelope.binding,
        request: input.request,
        result,
        modelSelection: input.envelope.modelSelection,
      });
      return projection;
    },
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

async function performOperation(
  input: Parameters<OperationExecutor["perform"]>[0],
  options: ProductionOperationRuntimeOptions,
  store: ArtifactStore,
  afterWorkspaceBoundary?: (boundary: OperationRuntimeBoundary) => void,
): Promise<ObservationResult> {
  if (input.request.kind === "observe") {
    return performObservation({
      request: input.request,
      envelope: input.envelope,
      options,
      signal: input.signal,
    });
  }
  if (input.request.kind === "workspace_artifact_action") {
    return performWorkspaceAction({
      request: input.request,
      envelope: input.envelope,
      options,
      store,
      signal: input.signal,
      afterBoundary: afterWorkspaceBoundary,
    });
  }
  if (input.request.kind === "workspace_artifact_observation") {
    return performWorkspaceObservation({
      request: input.request,
      envelope: input.envelope,
      options,
      store,
      signal: input.signal,
    });
  }
  if (input.request.kind === "review_validation") {
    return performReviewValidation({
      request: input.request,
      envelope: input.envelope,
      options,
      store,
      signal: input.signal,
    });
  }
  if (input.request.kind === "external_effect") {
    return performExternalEffect({
      request: input.request,
      envelope: input.envelope,
      options,
      signal: input.signal,
    });
  }
  return performPromotion({
    request: input.request,
    envelope: input.envelope,
    store,
    signal: input.signal,
  });
}
