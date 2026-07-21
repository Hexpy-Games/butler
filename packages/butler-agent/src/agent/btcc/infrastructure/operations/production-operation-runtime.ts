import type { OperationExecutor } from "../../core/index.ts";
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
      const existing = store.loadOperation(input.request);
      if (existing) {
        if (input.request.kind === "workspace_artifact_action") {
          cleanupWorkspaceAction(store, input.request);
        }
        return existing;
      }
      const result = input.request.kind === "observe"
        ? await performObservation({
            request: input.request,
            envelope: input.envelope,
            options,
            signal: input.signal,
          })
        : input.request.kind === "workspace_artifact_action"
          ? await performWorkspaceAction({
              request: input.request,
              envelope: input.envelope,
              options,
              store,
              signal: input.signal,
              afterBoundary: afterWorkspaceBoundary,
            })
          : input.request.kind === "review_validation"
            ? await performReviewValidation({
                request: input.request,
                envelope: input.envelope,
                options,
                store,
                signal: input.signal,
              })
            : performPromotion({
                request: input.request,
                envelope: input.envelope,
                store,
                signal: input.signal,
              });
      if (input.request.kind === "workspace_artifact_action") {
        afterWorkspaceBoundary?.("before_result_persist");
      }
      store.saveOperation(input.request, result);
      if (input.request.kind === "workspace_artifact_action") {
        cleanupWorkspaceAction(store, input.request);
      }
      return result;
    },
  };
}
