import type { ContentRef } from "../core/index.ts";
import type { FinalDossierProduct } from "../consolidation/index.ts";
import type { PlanningCandidate } from "../planning/contracts.ts";
import type { PreparedReportProduct } from "../reporting/index.ts";
import type { ReviewedManagedProgramState } from "../work-ledger/index.ts";

type ContinuationCandidateBase = {
  candidateId: string;
  ledgerId: string;
  programId: string;
  expectedManifestRevision: number;
  baseManifestHash: string;
  sourceTurnId: string;
  originalGoalContractRef: ContentRef;
  anchorRef: ContentRef;
  blockerRef: ContentRef;
};

export type ContinuationCandidate =
  | (ContinuationCandidateBase & {
      continuationKind: "managed_deferral" | "user_stopped";
      context?: ContinuationContext;
    })
  | (ContinuationCandidateBase & {
      continuationKind: "managed_finalization";
      context: ContinuationContext & { finalization: FinalizationContinuation };
    });

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
  finalization?: FinalizationContinuation;
};

export type FinalizationContinuation =
  | {
      resumeAt: "consolidation";
      closedProgram: ReviewedManagedProgramState;
    }
  | {
      resumeAt: "reporting";
      finalDossier: FinalDossierProduct;
    }
  | {
      resumeAt: "delivery";
      preparedReport: PreparedReportProduct;
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
    }
  | {
      kind: "stopped_finalization";
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
      context: ContinuationContext & { finalization: FinalizationContinuation };
    };
