import {
  contentRef,
  OperationRejectedError,
  type ObservationResult,
  type PhaseEnvelope,
} from "../../core/index.ts";
import type { ProductionOperationRuntimeOptions } from "./contracts.ts";
import { ArtifactStore } from "./artifact-store.ts";
import { assertActive, operationContent, sameRef } from "./operation-helpers.ts";
import {
  syncCompleteTarget,
  workspaceContentRoot,
} from "../artifact-snapshot/index.ts";

type WorkspaceObservation = Extract<import("../../core/index.ts").OperationRequest, {
  kind: "workspace_artifact_observation";
}>;

export async function performWorkspaceObservation(input: {
  request: WorkspaceObservation;
  envelope: PhaseEnvelope;
  options: ProductionOperationRuntimeOptions;
  store: ArtifactStore;
  signal?: AbortSignal;
}): Promise<ObservationResult> {
  assertActive(input.signal);
  const workspace = input.store.loadWorkspaceByRef(input.request.workspaceRef.id);
  if (!workspace || !sameRef(workspace.provision.workspace.ref, input.request.workspaceRef)) {
    throw new Error("BTCC artifact observation references an unknown workspace");
  }
  const contentRoot = workspaceContentRoot(workspace.workspaceRoot);
  const before = input.store.snapshots.captureWorkspace(
    workspace.workspaceRoot,
    workspace.targetKind,
    workspace.baselineTargetState,
  );
  input.options.validateOperationInput({
    envelope: input.envelope,
    request: input.request,
    args: input.request.input,
  });
  const execute = input.options.createWorkspaceObservationExecutor({
    workspacePath: contentRoot,
    envelope: input.envelope,
    request: input.request,
  });
  let output: Awaited<ReturnType<typeof execute>>;
  try {
    output = await execute({
      name: input.request.capabilityRef,
      args: input.request.input,
      rawArguments: JSON.stringify(input.request.input),
      signal: input.signal,
    });
  } catch (error) {
    restoreReadOnlyWorkspace(input.store, workspace, before, contentRoot);
    throw error;
  }
  const payload = operationContent(output);
  const observed = input.store.snapshots.captureWorkspace(
    workspace.workspaceRoot,
    workspace.targetKind,
    workspace.baselineTargetState,
  );
  if (!sameRef(before.ref, observed.ref)) {
    restoreReadOnlyWorkspace(input.store, workspace, before, contentRoot);
    throw new OperationRejectedError(
      "read_only_task_mutated_workspace",
      "A read-only workspace operation produced a persistent workspace delta.",
    );
  }
  assertActive(input.signal);
  return {
    requestId: input.request.requestId,
    outcome: "observed",
    observationRef: contentRef("artifact-workspace-observation", {
      requestId: input.request.requestId,
      capabilityRef: input.request.capabilityRef,
      workspaceRef: input.request.workspaceRef,
      targetSnapshotRef: observed.ref,
      payload: payload.payloadSource
        ? {
            sha256: payload.payloadSource.sha256,
            byteLength: payload.payloadSource.byteLength,
          }
        : payload.content,
    }),
    targetSnapshotRef: observed.ref,
    content: payload.content,
    ...(payload.payloadSource ? { payloadSource: payload.payloadSource } : {}),
    ...(payload.executionSummary ? { executionSummary: payload.executionSummary } : {}),
  };
}

function restoreReadOnlyWorkspace(
  store: ArtifactStore,
  workspace: NonNullable<ReturnType<ArtifactStore["loadWorkspaceByRef"]>>,
  before: ReturnType<ArtifactStore["snapshots"]["captureWorkspace"]>,
  contentRoot: string,
): void {
  const current = store.snapshots.captureWorkspace(
    workspace.workspaceRoot,
    workspace.targetKind,
    workspace.baselineTargetState,
  );
  if (sameRef(current.ref, before.ref)) return;
  store.snapshots.materialize(before, contentRoot, { replacePayload: true });
  syncCompleteTarget(contentRoot);
}
