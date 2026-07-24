import { contentRef, type ObservationResult, type PhaseEnvelope } from "../../core/index.ts";
import type { ProductionOperationRuntimeOptions } from "./contracts.ts";
import { ArtifactStore } from "./artifact-store.ts";
import { assertActive, operationContent, sameRef } from "./operation-helpers.ts";
import { workspaceContentRoot } from "./target-snapshot.ts";

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
  input.options.validateOperationInput({
    envelope: input.envelope,
    request: input.request,
    args: input.request.input,
  });
  const execute = input.options.createWorkspaceObservationExecutor({
    workspacePath: workspaceContentRoot(workspace.workspaceRoot),
    envelope: input.envelope,
    request: input.request,
  });
  const output = await execute({
    name: input.request.capabilityRef,
    args: input.request.input,
    rawArguments: JSON.stringify(input.request.input),
    signal: input.signal,
  });
  assertActive(input.signal);
  const payload = operationContent(output);
  return {
    requestId: input.request.requestId,
    outcome: "observed",
    observationRef: contentRef("artifact-workspace-observation", {
      requestId: input.request.requestId,
      capabilityRef: input.request.capabilityRef,
      workspaceRef: input.request.workspaceRef,
      payload: payload.payloadSource
        ? {
            sha256: payload.payloadSource.sha256,
            byteLength: payload.payloadSource.byteLength,
          }
        : payload.content,
    }),
    content: payload.content,
    ...(payload.payloadSource ? { payloadSource: payload.payloadSource } : {}),
    ...(payload.executionSummary ? { executionSummary: payload.executionSummary } : {}),
  };
}
