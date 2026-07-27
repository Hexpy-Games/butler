import type { ContentRef } from "../core/index.ts";
import type { PlanningCandidate } from "../planning/contracts.ts";

export type ContinuationCandidate = {
  continuationKind: "managed_deferral" | "user_stopped";
  candidateId: string;
  ledgerId: string;
  programId: string;
  expectedManifestRevision: number;
  baseManifestHash: string;
  sourceTurnId: string;
  originalGoalContractRef: ContentRef;
  anchorRef: ContentRef;
  blockerRef: ContentRef;
  context?: ContinuationContext;
};

export type ContinuationContext = {
  originalGoalContract: Record<string, unknown> | null;
  acceptedPlan?: PlanningCandidate;
  blocker: {
    sourceState: string;
    reason: string;
    readiness: unknown;
  };
  frontier: {
    currentWorkRef?: ContentRef;
    currentTaskRef?: ContentRef;
    openWorkRefs: ContentRef[];
    openTaskRefs: ContentRef[];
    completedTasks?: ContinuationTaskState[];
    interruptedTask?: ContinuationTaskState;
    pendingTasks?: ContinuationTaskState[];
  };
};

export type ContinuationTaskState = {
  task: Record<string, unknown> & { ref: ContentRef };
  status: "reviewed_passed" | "interrupted" | "pending";
  dependencyTaskRefs: ContentRef[];
  resultRef?: ContentRef;
  reviewRef?: ContentRef;
};

export type ContinuationBinding =
  | { kind: "new_request"; inboxId: string; ref: ContentRef }
  | {
      kind: "deferred_goal";
      inboxId: string;
      ref: ContentRef;
      candidateId: string;
      ledgerId: string;
      programId: string;
      expectedManifestRevision: number;
      baseManifestHash: string;
      sourceTurnId: string;
      originalGoalContractRef: ContentRef;
      anchorRef: ContentRef;
      context?: ContinuationContext;
    }
  | {
      kind: "stopped_program";
      inboxId: string;
      ref: ContentRef;
      candidateId: string;
      ledgerId: string;
      programId: string;
      expectedManifestRevision: number;
      baseManifestHash: string;
      sourceTurnId: string;
      originalGoalContractRef: ContentRef;
      anchorRef: ContentRef;
      context?: ContinuationContext;
    };
