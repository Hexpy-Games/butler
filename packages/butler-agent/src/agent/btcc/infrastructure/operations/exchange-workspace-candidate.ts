import { contentRef } from "../../core/index.ts";
import { exchangeCompleteRoots } from "../../../../foundation/atomic-root-exchange.ts";
import {
  ArtifactStore,
  type StoredWorkspace,
  type WorkspaceActionJournal,
} from "./artifact-store.ts";
import { sameRef } from "./operation-helpers.ts";
import {
  captureWorkspaceSnapshot,
  sameWorkspacePayload,
  workspaceContentRoot,
} from "./target-snapshot.ts";

export type WorkspaceActionBoundary =
  | "tool_mutated"
  | "candidate_prepared"
  | "workspace_exchanged";

export function exchangePreparedCandidate(
  input: {
    signal?: AbortSignal;
    store: ArtifactStore;
    afterBoundary?: (boundary: WorkspaceActionBoundary) => void;
  },
  workspace: StoredWorkspace,
  journal: WorkspaceActionJournal,
): WorkspaceActionJournal {
  input.signal?.throwIfAborted();
  const before = requireSnapshot(input.store, journal.beforeSnapshotRef);
  const candidate = requireSnapshot(input.store, requireCandidateRef(journal));
  const workspaceSnapshot = captureWorkspaceSnapshot(
    workspace.workspaceRoot,
    workspace.targetKind,
    workspace.baselineTargetState,
  );
  const overlaySnapshot = captureWorkspaceSnapshot(
    journal.overlayRoot,
    workspace.targetKind,
    workspace.baselineTargetState,
  );

  if (
    sameWorkspacePayload(workspaceSnapshot, before) &&
    sameWorkspacePayload(overlaySnapshot, candidate)
  ) {
    exchangeCompleteRoots(
      workspaceContentRoot(journal.overlayRoot),
      workspaceContentRoot(workspace.workspaceRoot),
    );
    input.afterBoundary?.("workspace_exchanged");
  } else if (
    !sameWorkspacePayload(workspaceSnapshot, candidate) ||
    !sameWorkspacePayload(overlaySnapshot, before)
  ) {
    throw new Error("BTCC workspace action cannot reconcile its atomic exchange");
  }

  const observed = captureWorkspaceSnapshot(
    workspace.workspaceRoot,
    workspace.targetKind,
    workspace.baselineTargetState,
  );
  if (!sameWorkspacePayload(observed, candidate)) {
    throw new Error("BTCC Program workspace does not equal its prepared payload");
  }
  input.store.saveSnapshot(observed);
  return bindObservedCandidate(journal, observed.ref);
}

export function requireWorkspaceCandidate(
  store: ArtifactStore,
  workspace: StoredWorkspace,
  journal: WorkspaceActionJournal,
): void {
  const expected = requireSnapshot(store, requireCandidateRef(journal));
  const current = captureWorkspaceSnapshot(
    workspace.workspaceRoot,
    workspace.targetKind,
    workspace.baselineTargetState,
  );
  if (!sameWorkspacePayload(current, expected)) {
    throw new Error("BTCC Program workspace does not equal its prepared payload");
  }
}

function bindObservedCandidate(
  journal: WorkspaceActionJournal,
  targetSnapshotRef: { id: string; sha256: string },
): WorkspaceActionJournal {
  const result = journal.result;
  if (!result?.artifactRevisionRef) {
    throw new Error("BTCC workspace action has no durable prepared result");
  }
  return {
    ...journal,
    status: "workspace_exchanged",
    candidateSnapshotRef: targetSnapshotRef,
    result: {
      ...result,
      targetSnapshotRef,
      observationRef: contentRef("workspace-operation", {
        requestId: journal.request.requestId,
        artifactRevisionRef: result.artifactRevisionRef,
        targetSnapshotRef,
      }),
    },
  };
}

function requireCandidateRef(journal: WorkspaceActionJournal) {
  if (!journal.candidateSnapshotRef || !journal.result) {
    throw new Error("BTCC workspace action has no durable prepared candidate");
  }
  return journal.candidateSnapshotRef;
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
