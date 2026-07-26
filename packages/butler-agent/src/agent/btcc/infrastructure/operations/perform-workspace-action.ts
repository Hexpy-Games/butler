import { existsSync } from "node:fs";
import {
  contentRef,
  type ObservationResult,
  type PhaseEnvelope,
} from "../../core/index.ts";
import { operationRoundScope } from "../../core/operation-identity.ts";
import type { ProductionOperationRuntimeOptions } from "./contracts.ts";
import {
  ArtifactStore,
  type StoredWorkspace,
  type WorkspaceActionJournal,
} from "./artifact-store.ts";
import { assertActive, operationContent, sameRef } from "./operation-helpers.ts";
import {
  resolveWorkspaceTarget,
  syncCompleteTarget,
  workspaceContentRoot,
} from "../artifact-snapshot/index.ts";
import {
  requireAcceptedWorkspaceDelta,
  requireWorkspaceOperationRoot,
  requireWorkspaceMutationRequest,
  workspaceCapabilityRejection,
} from "./workspace-mutation-boundary.ts";

type WorkspaceRequest = Extract<import("../../core/index.ts").OperationRequest, {
  kind: "workspace_artifact_action";
}>;

export type WorkspaceActionBoundary =
  | "tool_mutated"
  | "candidate_prepared"
  | "workspace_applied";

export async function performWorkspaceAction(input: {
  request: WorkspaceRequest;
  envelope: PhaseEnvelope;
  options: ProductionOperationRuntimeOptions;
  store: ArtifactStore;
  signal?: AbortSignal;
  afterBoundary?: (boundary: WorkspaceActionBoundary) => void;
}): Promise<ObservationResult> {
  assertActive(input.signal);
  const scopeId = operationRoundScope(input.envelope.binding);
  const workspace = requireWorkspace(input.store, input.request);
  requireWorkspaceOperationRoot(workspace, input.request);
  const mutationAuthority = requireWorkspaceMutationRequest(
    input.envelope.operationAuthority,
    input.request.relativeTarget,
  );
  let journal =
    input.store.loadWorkspaceAction(scopeId, input.request) ??
    reserveAction(input, workspace);

  if (journal.status === "dispatching") {
    restoreBeforeSnapshot(input.store, workspace, journal);
    journal = { ...journal, status: "reserved" };
    input.store.saveWorkspaceAction(scopeId, journal);
  }

  if (journal.status === "reserved") {
    validateDispatch(input);
    journal = { ...journal, status: "dispatching" };
    input.store.saveWorkspaceAction(scopeId, journal);
    let payload: ReturnType<typeof operationContent>;
    try {
      payload = await dispatchWorkspaceCapability(input, workspace);
    } catch (error) {
      restoreBeforeSnapshot(input.store, workspace, journal);
      resetReservedAction(input.store, scopeId, journal);
      throw workspaceCapabilityRejection(error);
    }
    journal = {
      ...journal,
      status: "tool_completed",
      operationOutput: payload,
    };
    input.store.saveWorkspaceAction(scopeId, journal);
    input.afterBoundary?.("tool_mutated");
  }

  if (journal.status === "tool_completed" && journal.operationOutput) {
    try {
      journal = prepareAppliedWorkspace(
        input,
        workspace,
        journal,
        journal.operationOutput,
        mutationAuthority,
      );
      input.store.saveWorkspaceAction(scopeId, journal);
    } catch (error) {
      restoreBeforeSnapshot(input.store, workspace, journal);
      resetReservedAction(input.store, scopeId, journal);
      throw workspaceCapabilityRejection(error);
    }
    input.afterBoundary?.("candidate_prepared");
  }

  if (journal.status === "workspace_observed" && journal.result) {
    return journal.result;
  }
  if (journal.status === "candidate_prepared") {
    journal = { ...journal, status: "workspace_applied" };
    input.store.saveWorkspaceAction(scopeId, journal);
    input.afterBoundary?.("workspace_applied");
  }
  if (journal.status !== "workspace_applied" || !journal.result) {
    throw new Error("BTCC workspace action did not reach its durable applied result");
  }
  requireWorkspaceCandidate(input.store, workspace, journal);
  return journal.result;
}

function validateDispatch(
  input: Parameters<typeof performWorkspaceAction>[0],
): void {
  try {
    input.options.validateOperationInput({
      envelope: input.envelope,
      request: input.request,
      args: input.request.input,
    });
  } catch (error) {
    throw workspaceCapabilityRejection(error);
  }
  assertActive(input.signal);
}

function resetReservedAction(
  store: ArtifactStore,
  scopeId: string,
  journal: WorkspaceActionJournal,
): void {
  store.saveWorkspaceAction(scopeId, {
    ...journal,
    status: "reserved",
    operationOutput: undefined,
    candidateSnapshotRef: undefined,
    result: undefined,
  });
}

async function dispatchWorkspaceCapability(
  input: Parameters<typeof performWorkspaceAction>[0],
  workspace: StoredWorkspace,
): Promise<ReturnType<typeof operationContent>> {
  const args = workspaceCapabilityInput(input.request, workspace);
  const execute = input.options.createWorkspaceToolExecutor({
    workspacePath: workspaceContentRoot(workspace.workspaceRoot),
    envelope: input.envelope,
    request: input.request,
  });
  const output = await execute({
    name: input.request.capabilityRef,
    args,
    rawArguments: JSON.stringify(args),
    signal: input.signal,
  });
  return operationContent(output);
}

function workspaceCapabilityInput(
  request: WorkspaceRequest,
  workspace: StoredWorkspace,
): Record<string, unknown> {
  if (request.capabilityRef !== "write_file" || workspace.targetKind !== "file") {
    return request.input;
  }
  return { ...request.input, path: "target", create_parents: true };
}

function reserveAction(
  input: Parameters<typeof performWorkspaceAction>[0],
  workspace: StoredWorkspace,
): WorkspaceActionJournal {
  const before = input.store.snapshots.captureWorkspace(
    workspace.workspaceRoot,
    workspace.targetKind,
    workspace.baselineTargetState,
  );
  const journal: WorkspaceActionJournal = {
    request: input.request,
    workspaceRef: workspace.provision.workspace.ref,
    beforeSnapshotRef: before.ref,
    status: "reserved",
  };
  input.store.saveWorkspaceAction(operationRoundScope(input.envelope.binding), journal);
  return journal;
}

function prepareAppliedWorkspace(
  input: Parameters<typeof performWorkspaceAction>[0],
  workspace: StoredWorkspace,
  journal: WorkspaceActionJournal,
  payload: ReturnType<typeof operationContent>,
  mutationAuthority: ReturnType<typeof requireWorkspaceMutationRequest>,
): WorkspaceActionJournal {
  const candidate = input.store.snapshots.captureWorkspace(
    workspace.workspaceRoot,
    workspace.targetKind,
    workspace.baselineTargetState,
  );
  const before = requireSnapshot(input.store, journal.beforeSnapshotRef);
  requireAcceptedWorkspaceDelta(mutationAuthority, before, candidate);
  if (sameRef(candidate.ref, journal.beforeSnapshotRef)) {
    return {
      ...journal,
      status: "workspace_observed",
      candidateSnapshotRef: candidate.ref,
      result: operationResult(input, workspace, candidate.ref, payload, "observed"),
    };
  }
  const target = resolveWorkspaceTarget({
    workspaceRoot: workspace.workspaceRoot,
    targetKind: workspace.targetKind,
    relativeTarget: input.request.relativeTarget,
  });
  if (!existsSync(target)) {
    throw new Error("BTCC workspace capability did not materialize its declared target");
  }
  syncCompleteTarget(target);
  const artifactRevisionRef = contentRef("artifact-revision", {
    workspaceRef: workspace.provision.workspace.ref,
    relativeTarget: input.request.relativeTarget,
    capabilityRef: input.request.capabilityRef,
    previousSnapshotRef: journal.beforeSnapshotRef,
    contentSha256: input.store.snapshots.contentSha256ForTarget(
      candidate,
      input.request.relativeTarget,
    ),
    requestId: input.request.requestId,
  });
  return {
    ...journal,
    status: "candidate_prepared",
    candidateSnapshotRef: candidate.ref,
    result: operationResult(
      input,
      workspace,
      candidate.ref,
      payload,
      "workspace_artifact_applied",
      artifactRevisionRef,
    ),
  };
}

function operationResult(
  input: Parameters<typeof performWorkspaceAction>[0],
  workspace: StoredWorkspace,
  targetSnapshotRef: { id: string; sha256: string },
  payload: ReturnType<typeof operationContent>,
  outcome: ObservationResult["outcome"],
  artifactRevisionRef?: { id: string; sha256: string },
): ObservationResult {
  return {
    requestId: input.request.requestId,
    outcome,
    observationRef: contentRef("workspace-operation", {
      requestId: input.request.requestId,
      workspaceRef: workspace.provision.workspace.ref,
      targetSnapshotRef,
      ...(artifactRevisionRef ? { artifactRevisionRef } : {}),
    }),
    ...(artifactRevisionRef ? { artifactRevisionRef } : {}),
    targetSnapshotRef,
    content: payload.content,
    ...(payload.payloadSource ? { payloadSource: payload.payloadSource } : {}),
    ...(payload.executionSummary ? { executionSummary: payload.executionSummary } : {}),
  };
}

function restoreBeforeSnapshot(
  store: ArtifactStore,
  workspace: StoredWorkspace,
  journal: WorkspaceActionJournal,
): void {
  const before = requireSnapshot(store, journal.beforeSnapshotRef);
  store.snapshots.materialize(before, workspaceContentRoot(workspace.workspaceRoot), {
    replacePayload: true,
  });
}

function requireWorkspaceCandidate(
  store: ArtifactStore,
  workspace: StoredWorkspace,
  journal: WorkspaceActionJournal,
): void {
  if (!journal.candidateSnapshotRef) {
    throw new Error("BTCC workspace action has no durable candidate");
  }
  const current = store.snapshots.captureWorkspace(
    workspace.workspaceRoot,
    workspace.targetKind,
    workspace.baselineTargetState,
  );
  if (!sameRef(current.ref, journal.candidateSnapshotRef)) {
    throw new Error("BTCC Program workspace changed after its applied result");
  }
}

function requireSnapshot(
  store: ArtifactStore,
  ref: { id: string; sha256: string },
) {
  const snapshot = store.loadSnapshot(ref.id);
  if (!snapshot || !sameRef(snapshot.ref, ref)) {
    throw new Error("BTCC workspace action lost its exact durable snapshot");
  }
  return snapshot;
}

function requireWorkspace(store: ArtifactStore, request: WorkspaceRequest): StoredWorkspace {
  const workspace = store.loadWorkspaceByRef(request.workspaceRef.id);
  if (!workspace || !sameRef(workspace.provision.workspace.ref, request.workspaceRef)) {
    throw new Error("BTCC workspace action references an unknown workspace");
  }
  return workspace;
}
