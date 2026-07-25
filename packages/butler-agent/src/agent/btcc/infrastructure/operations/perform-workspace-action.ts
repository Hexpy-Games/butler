import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  contentRef,
  digest,
  type ObservationResult,
  type PhaseEnvelope,
} from "../../core/index.ts";
import type { ProductionOperationRuntimeOptions } from "./contracts.ts";
import {
  ArtifactStore,
  type StoredWorkspace,
  type WorkspaceActionJournal,
} from "./artifact-store.ts";
import {
  assertActive,
  operationContent,
  sameRef,
} from "./operation-helpers.ts";
import {
  bytesSha256,
  captureWorkspaceSnapshot,
  materializeSnapshot,
  removeOwnedRoot,
  resolveWorkspaceTarget,
  syncCompleteTarget,
  workspaceContentRoot,
} from "./target-snapshot.ts";
import {
  exchangePreparedCandidate,
  requireWorkspaceCandidate,
  type WorkspaceActionBoundary,
} from "./exchange-workspace-candidate.ts";
import { operationRoundScope } from "../../core/operation-identity.ts";
import {
  requireAcceptedWorkspaceDelta,
  requireWorkspaceOperationRoot,
  requireWorkspaceMutationRequest,
  workspaceCapabilityRejection,
} from "./workspace-mutation-boundary.ts";

type WorkspaceRequest = Extract<import("../../core/index.ts").OperationRequest, {
  kind: "workspace_artifact_action";
}>;
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
  let journal = input.store.loadWorkspaceAction(scopeId, input.request);
  if (!journal) journal = reserveAction(input, workspace);

  let shouldDispatch = false;
  if (journal.status === "reserved") {
    materializeActionOverlay(input.store, journal);
    const args = input.request.input;
    try {
      input.options.validateOperationInput({
        envelope: input.envelope,
        request: input.request,
        args,
      });
    } catch (error) {
      throw workspaceCapabilityRejection(error);
    }
    assertActive(input.signal);
    journal = { ...journal, status: "dispatching" };
    input.store.saveWorkspaceAction(scopeId, journal);
    shouldDispatch = true;
  }

  if (journal.status === "dispatching") {
    let payload: ReturnType<typeof operationContent> = {
      content: "workspace capability recovered from its durable operation overlay",
    };
    if (shouldDispatch) {
      try {
        payload = await dispatchWorkspaceCapability(input, workspace, journal);
      } catch (error) {
        resetInterruptedDispatch(input.store, scopeId, journal);
        throw workspaceCapabilityRejection(error);
      }
      input.afterBoundary?.("tool_mutated");
    }
    try {
      journal = prepareCandidate(input, workspace, journal, payload, mutationAuthority);
    } catch (error) {
      resetInterruptedDispatch(input.store, scopeId, journal);
      throw workspaceCapabilityRejection(error);
    }
    input.afterBoundary?.("candidate_prepared");
  }

  if (journal.status === "workspace_observed" && journal.result) {
    return journal.result;
  }

  if (journal.status === "candidate_prepared") {
    assertActive(input.signal);
    journal = exchangePreparedCandidate(input, workspace, journal);
    input.store.saveWorkspaceAction(scopeId, journal);
  }

  if (journal.status !== "workspace_exchanged" || !journal.result) {
    throw new Error("BTCC workspace action did not reach its durable exchanged result");
  }
  requireWorkspaceCandidate(input.store, workspace, journal);
  return journal.result;
}

export function cleanupWorkspaceAction(
  store: ArtifactStore,
  scopeId: string,
  request: WorkspaceRequest,
): void {
  const journal = store.loadWorkspaceAction(scopeId, request);
  if (journal?.status === "workspace_exchanged" || journal?.status === "workspace_observed") {
    removeOwnedRoot(journal.overlayRoot);
  }
}

async function dispatchWorkspaceCapability(
  input: Parameters<typeof performWorkspaceAction>[0],
  workspace: StoredWorkspace,
  journal: WorkspaceActionJournal,
): Promise<ReturnType<typeof operationContent>> {
  const args = workspaceCapabilityInput(input.request, workspace);
  const execute = input.options.createWorkspaceToolExecutor({
    workspacePath: workspaceContentRoot(journal.overlayRoot),
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

function resetInterruptedDispatch(
  store: ArtifactStore,
  scopeId: string,
  journal: WorkspaceActionJournal,
): void {
  removeOwnedRoot(journal.overlayRoot);
  store.saveWorkspaceAction(scopeId, {
    ...journal,
    status: "reserved",
    candidateSnapshotRef: undefined,
    result: undefined,
  });
}

function reserveAction(
  input: Parameters<typeof performWorkspaceAction>[0],
  workspace: StoredWorkspace,
): WorkspaceActionJournal {
  const before = captureWorkspaceSnapshot(
    workspace.workspaceRoot,
    workspace.targetKind,
    workspace.baselineTargetState,
  );
  input.store.saveSnapshot(before);
  const journal: WorkspaceActionJournal = {
    request: input.request,
    workspaceRef: workspace.provision.workspace.ref,
    overlayRoot: join(
      input.options.butlerData,
      "runtime",
      "btcc-artifacts",
      "workspace-actions",
      digest(`${operationRoundScope(input.envelope.binding)}\0${input.request.requestId}`),
    ),
    beforeSnapshotRef: before.ref,
    status: "reserved",
  };
  input.store.saveWorkspaceAction(operationRoundScope(input.envelope.binding), journal);
  return journal;
}

function materializeActionOverlay(store: ArtifactStore, journal: WorkspaceActionJournal): void {
  const before = store.loadSnapshot(journal.beforeSnapshotRef.id);
  if (!before || !sameRef(before.ref, journal.beforeSnapshotRef)) {
    throw new Error("BTCC workspace action lost its exact starting snapshot");
  }
  removeOwnedRoot(journal.overlayRoot);
  materializeSnapshot(before, workspaceContentRoot(journal.overlayRoot));
}

function prepareCandidate(
  input: Parameters<typeof performWorkspaceAction>[0],
  workspace: StoredWorkspace,
  journal: WorkspaceActionJournal,
  payload: ReturnType<typeof operationContent>,
  mutationAuthority: ReturnType<typeof requireWorkspaceMutationRequest>,
): WorkspaceActionJournal {
  const target = resolveWorkspaceTarget({
    workspaceRoot: journal.overlayRoot,
    targetKind: workspace.targetKind,
    relativeTarget: input.request.relativeTarget,
  });
  const candidate = captureWorkspaceSnapshot(
    journal.overlayRoot,
    workspace.targetKind,
    workspace.baselineTargetState,
  );
  const before = input.store.loadSnapshot(journal.beforeSnapshotRef.id);
  if (!before || !sameRef(before.ref, journal.beforeSnapshotRef)) {
    throw new Error("BTCC workspace action lost its exact starting snapshot");
  }
  requireAcceptedWorkspaceDelta(mutationAuthority, before, candidate);
  input.store.saveSnapshot(candidate);
  if (sameRef(candidate.ref, journal.beforeSnapshotRef)) {
    const result: ObservationResult = {
      requestId: input.request.requestId,
      outcome: "observed",
      observationRef: contentRef("workspace-observation", {
        requestId: input.request.requestId,
        workspaceRef: workspace.provision.workspace.ref,
        targetSnapshotRef: candidate.ref,
      }),
      targetSnapshotRef: candidate.ref,
      content: payload.content,
      ...(payload.payloadSource ? { payloadSource: payload.payloadSource } : {}),
      ...(payload.executionSummary ? { executionSummary: payload.executionSummary } : {}),
    };
    const observed = { ...journal, status: "workspace_observed" as const, result };
    input.store.saveWorkspaceAction(operationRoundScope(input.envelope.binding), observed);
    return observed;
  }
  if (!existsSync(target)) {
    throw new Error("BTCC workspace capability did not materialize its declared target");
  }
  syncCompleteTarget(workspaceContentRoot(journal.overlayRoot));
  const stat = lstatSync(target);
  const contentSha256 = stat.isFile()
    ? bytesSha256(readFileSync(target))
    : candidate.ref.sha256;
  const artifactRevisionRef = contentRef("artifact-revision", {
    workspaceRef: workspace.provision.workspace.ref,
    relativeTarget: input.request.relativeTarget,
    capabilityRef: input.request.capabilityRef,
    previousSnapshotRef: journal.beforeSnapshotRef,
    contentSha256,
    requestId: input.request.requestId,
  });
  const result: ObservationResult = {
    requestId: input.request.requestId,
    outcome: "workspace_artifact_applied",
    observationRef: contentRef("workspace-operation", {
      requestId: input.request.requestId,
      artifactRevisionRef,
      targetSnapshotRef: candidate.ref,
    }),
    artifactRevisionRef,
    targetSnapshotRef: candidate.ref,
    content: payload.content,
    ...(payload.payloadSource ? { payloadSource: payload.payloadSource } : {}),
    ...(payload.executionSummary ? { executionSummary: payload.executionSummary } : {}),
  };
  const prepared: WorkspaceActionJournal = {
    ...journal,
    status: "candidate_prepared",
    candidateSnapshotRef: candidate.ref,
    result,
  };
  input.store.saveWorkspaceAction(operationRoundScope(input.envelope.binding), prepared);
  return prepared;
}

function requireWorkspace(store: ArtifactStore, request: WorkspaceRequest): StoredWorkspace {
  const workspace = store.loadWorkspaceByRef(request.workspaceRef.id);
  if (!workspace || !sameRef(workspace.provision.workspace.ref, request.workspaceRef)) {
    throw new Error("BTCC workspace action references an unknown workspace");
  }
  return workspace;
}
