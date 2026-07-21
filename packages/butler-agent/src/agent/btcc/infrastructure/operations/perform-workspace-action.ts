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
import { exchangeCompleteTarget } from "./atomic-target-exchange.ts";
import {
  assertActive,
  operationContent,
  parseToolInput,
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

type WorkspaceRequest = Extract<import("../../core/index.ts").OperationRequest, {
  kind: "workspace_artifact_action";
}>;

export type WorkspaceActionBoundary =
  | "tool_mutated"
  | "candidate_prepared"
  | "workspace_exchanged";

export async function performWorkspaceAction(input: {
  request: WorkspaceRequest;
  envelope: PhaseEnvelope;
  options: ProductionOperationRuntimeOptions;
  store: ArtifactStore;
  signal?: AbortSignal;
  afterBoundary?: (boundary: WorkspaceActionBoundary) => void;
}): Promise<ObservationResult> {
  assertActive(input.signal);
  const workspace = requireWorkspace(input.store, input.request);
  let journal = input.store.loadWorkspaceAction(input.request);
  if (!journal) journal = reserveAction(input, workspace);

  let shouldDispatch = false;
  if (journal.status === "reserved") {
    materializeActionOverlay(input.store, journal);
    const args = parseToolInput(input.request.input);
    input.options.validateOperationInput({
      envelope: input.envelope,
      request: input.request,
      args,
    });
    assertActive(input.signal);
    journal = { ...journal, status: "dispatching" };
    input.store.saveWorkspaceAction(journal);
    shouldDispatch = true;
  }

  if (journal.status === "dispatching") {
    let content = "workspace capability recovered from its durable operation overlay";
    if (shouldDispatch) {
      try {
        content = await dispatchWorkspaceCapability(input, journal);
      } catch (error) {
        resetInterruptedDispatch(input.store, journal);
        throw error;
      }
      input.afterBoundary?.("tool_mutated");
    }
    journal = prepareCandidate(input, workspace, journal, content);
    input.afterBoundary?.("candidate_prepared");
  }

  if (journal.status === "candidate_prepared") {
    assertActive(input.signal);
    journal = exchangePreparedCandidate(input, workspace, journal);
  }

  if (journal.status !== "workspace_exchanged" || !journal.result) {
    throw new Error("BTCC workspace action did not reach its durable exchanged result");
  }
  requireWorkspaceCandidate(workspace, journal);
  return journal.result;
}

export function cleanupWorkspaceAction(
  store: ArtifactStore,
  request: WorkspaceRequest,
): void {
  const journal = store.loadWorkspaceAction(request);
  if (journal?.status === "workspace_exchanged") removeOwnedRoot(journal.overlayRoot);
}

async function dispatchWorkspaceCapability(
  input: Parameters<typeof performWorkspaceAction>[0],
  journal: WorkspaceActionJournal,
): Promise<string> {
  const args = parseToolInput(input.request.input);
  const execute = input.options.createWorkspaceToolExecutor({
    workspacePath: workspaceContentRoot(journal.overlayRoot),
    envelope: input.envelope,
    request: input.request,
  });
  const output = await execute({
    name: input.request.capabilityRef,
    args,
    rawArguments: input.request.input,
    signal: input.signal,
  });
  return operationContent(output);
}

function resetInterruptedDispatch(store: ArtifactStore, journal: WorkspaceActionJournal): void {
  removeOwnedRoot(journal.overlayRoot);
  store.saveWorkspaceAction({
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
  const before = captureWorkspaceSnapshot(workspace.workspaceRoot, workspace.targetKind);
  input.store.saveSnapshot(before);
  const journal: WorkspaceActionJournal = {
    request: input.request,
    workspaceRef: workspace.provision.workspace.ref,
    overlayRoot: join(
      input.options.butlerData,
      "runtime",
      "btcc-artifacts",
      "workspace-actions",
      digest(input.request.requestId),
    ),
    beforeSnapshotRef: before.ref,
    status: "reserved",
  };
  input.store.saveWorkspaceAction(journal);
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
  content: string,
): WorkspaceActionJournal {
  const target = resolveWorkspaceTarget({
    workspaceRoot: journal.overlayRoot,
    targetKind: workspace.targetKind,
    originalTargetPath: workspace.targetPath,
    relativeTarget: input.request.relativeTarget,
  });
  if (!existsSync(target) || !lstatSync(target).isFile()) {
    throw new Error("BTCC workspace capability did not materialize its declared file target");
  }
  const candidate = captureWorkspaceSnapshot(journal.overlayRoot, workspace.targetKind);
  input.store.saveSnapshot(candidate);
  syncCompleteTarget(workspaceContentRoot(journal.overlayRoot));
  const artifactRevisionRef = contentRef("artifact-revision", {
    workspaceRef: workspace.provision.workspace.ref,
    relativeTarget: input.request.relativeTarget,
    capabilityRef: input.request.capabilityRef,
    previousSnapshotRef: journal.beforeSnapshotRef,
    contentSha256: bytesSha256(readFileSync(target)),
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
    content,
  };
  const prepared: WorkspaceActionJournal = {
    ...journal,
    status: "candidate_prepared",
    candidateSnapshotRef: candidate.ref,
    result,
  };
  input.store.saveWorkspaceAction(prepared);
  return prepared;
}

function exchangePreparedCandidate(
  input: Parameters<typeof performWorkspaceAction>[0],
  workspace: StoredWorkspace,
  journal: WorkspaceActionJournal,
): WorkspaceActionJournal {
  const candidateRef = requireCandidateRef(journal);
  const workspaceSnapshot = captureWorkspaceSnapshot(workspace.workspaceRoot, workspace.targetKind);
  const overlaySnapshot = captureWorkspaceSnapshot(journal.overlayRoot, workspace.targetKind);
  if (sameRef(workspaceSnapshot.ref, journal.beforeSnapshotRef) &&
    sameRef(overlaySnapshot.ref, candidateRef)) {
    exchangeCompleteTarget(
      workspaceContentRoot(journal.overlayRoot),
      workspaceContentRoot(workspace.workspaceRoot),
    );
    input.afterBoundary?.("workspace_exchanged");
  } else if (!sameRef(workspaceSnapshot.ref, candidateRef) ||
    !sameRef(overlaySnapshot.ref, journal.beforeSnapshotRef)) {
    throw new Error("BTCC workspace action cannot reconcile its atomic exchange");
  }
  requireWorkspaceCandidate(workspace, journal);
  const exchanged = { ...journal, status: "workspace_exchanged" as const };
  input.store.saveWorkspaceAction(exchanged);
  return exchanged;
}

function requireWorkspaceCandidate(
  workspace: StoredWorkspace,
  journal: WorkspaceActionJournal,
): void {
  const current = captureWorkspaceSnapshot(workspace.workspaceRoot, workspace.targetKind);
  if (!sameRef(current.ref, requireCandidateRef(journal))) {
    throw new Error("BTCC Program workspace does not equal its prepared candidate");
  }
}

function requireCandidateRef(journal: WorkspaceActionJournal) {
  if (!journal.candidateSnapshotRef || !journal.result) {
    throw new Error("BTCC workspace action has no durable prepared candidate");
  }
  return journal.candidateSnapshotRef;
}

function requireWorkspace(store: ArtifactStore, request: WorkspaceRequest): StoredWorkspace {
  const workspace = store.loadWorkspaceByRef(request.workspaceRef.id);
  if (!workspace || !sameRef(workspace.provision.workspace.ref, request.workspaceRef)) {
    throw new Error("BTCC workspace action references an unknown workspace");
  }
  return workspace;
}
