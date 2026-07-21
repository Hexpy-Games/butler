import {
  OperationRejectedError,
  contentRef,
  type ObservationResult,
  type OperationExecutor,
  type OperationRequest,
} from "../../core/index.ts";
import { ArtifactStore } from "./artifact-store.ts";
import { ProductionArtifactWorkspaceRuntime } from "./artifact-workspace-runtime.ts";
import type {
  ProductionOperationRuntime,
  ProductionOperationRuntimeOptions,
} from "./contracts.ts";
import { performObservation } from "./perform-observation.ts";
import { performPromotion } from "./perform-promotion.ts";
import { performReviewValidation } from "./perform-review-validation.ts";
import {
  cleanupWorkspaceAction,
  performWorkspaceAction,
  type WorkspaceActionBoundary,
} from "./perform-workspace-action.ts";

export type OperationRuntimeBoundary = WorkspaceActionBoundary | "before_result_persist";

export function createProductionOperationRuntime(
  options: ProductionOperationRuntimeOptions,
): ProductionOperationRuntime {
  const store = new ArtifactStore(options.butlerData);
  return {
    artifacts: new ProductionArtifactWorkspaceRuntime(options, store),
    operations: createOperationExecutor(options, store),
  };
}

export function createOperationExecutor(
  options: ProductionOperationRuntimeOptions,
  store: ArtifactStore,
  afterWorkspaceBoundary?: (boundary: OperationRuntimeBoundary) => void,
): OperationExecutor {
  return {
    async perform(input) {
      const scopeId = input.envelope.binding.checkpointId;
      const existing = store.loadOperation(scopeId, input.request);
      if (existing) {
        if (input.request.kind === "workspace_artifact_action") {
          cleanupWorkspaceAction(store, scopeId, input.request);
        }
        return existing;
      }
      const result = await performOperation(input, options, store, afterWorkspaceBoundary).catch((error: unknown) => {
        if (error instanceof OperationRejectedError) {
          return rejectedOperation(input.request, error);
        }
        if (isAbortError(error) || input.signal?.aborted) throw error;
        if (input.request.kind !== "observe") throw error;
        return rejectedOperation(
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
      store.saveOperation(scopeId, input.request, result);
      if (input.request.kind === "workspace_artifact_action") {
        cleanupWorkspaceAction(store, scopeId, input.request);
      }
      return result;
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
  if (input.request.kind === "review_validation") {
    return performReviewValidation({
      request: input.request,
      envelope: input.envelope,
      options,
      store,
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

function rejectedOperation(
  request: OperationRequest,
  error: OperationRejectedError,
): ObservationResult {
  const content = JSON.stringify({ status: "rejected", code: error.code, message: error.message });
  return {
    requestId: request.requestId,
    outcome: "operation_rejected",
    observationRef: contentRef("operation-rejection", {
      requestId: request.requestId,
      capabilityRef: request.capabilityRef,
      code: error.code,
    }),
    content,
  };
}
