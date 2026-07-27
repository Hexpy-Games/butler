import type { ArtifactWorkspaceRuntime } from "../../artifact/index.ts";
import type { OperationExecutor, OperationRequest, PhaseEnvelope } from "../../core/index.ts";

export type ButlerOperationToolExecutor = (call: {
  name: string;
  args: Record<string, unknown>;
  rawArguments: string;
  signal?: AbortSignal;
}) => Promise<unknown>;

export type ProductionOperationRuntimeOptions = {
  butlerData: string;
  resolveTargetScope(targetScopeRef: string): Promise<{ targetPath: string }>;
  createToolExecutor(input: {
    envelope: PhaseEnvelope;
    request: Extract<OperationRequest, { kind: "observe" }>;
  }): ButlerOperationToolExecutor;
  createWorkspaceToolExecutor(input: {
    workspacePath: string;
    envelope: PhaseEnvelope;
    request: Extract<OperationRequest, { kind: "workspace_artifact_action" }>;
  }): ButlerOperationToolExecutor;
  createWorkspaceObservationExecutor(input: {
    workspacePath: string;
    envelope: PhaseEnvelope;
    request: Extract<OperationRequest, { kind: "workspace_artifact_observation" }>;
  }): ButlerOperationToolExecutor;
  createIsolatedValidationExecutor(input: {
    workspacePath: string;
    envelope: PhaseEnvelope;
    request: Extract<OperationRequest, { kind: "review_validation" }>;
  }): ButlerOperationToolExecutor;
  createExternalEffectExecutor(input: {
    envelope: PhaseEnvelope;
    request: Extract<OperationRequest, { kind: "external_effect" }>;
  }): ButlerOperationToolExecutor;
  validateOperationInput(input: {
    envelope: PhaseEnvelope;
    request: OperationRequest;
    args: Record<string, unknown>;
  }): void;
};

export type ProductionOperationRuntime = {
  artifacts: ArtifactWorkspaceRuntime;
  operations: OperationExecutor;
};
