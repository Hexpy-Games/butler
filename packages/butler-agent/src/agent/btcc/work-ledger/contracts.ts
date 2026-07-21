import type { GoalContractAcceptedProduct } from "../conception/index.ts";
import type { ContentRef } from "../core/index.ts";
import type { ResultCandidateProduct } from "../execution/index.ts";
import type {
  FeedbackPlanningAcceptedProduct,
  PlanningAcceptedProduct,
} from "../planning/index.ts";
import type { TaskReviewProduct } from "../review/index.ts";
import type { PromotionAuthorizationProduct } from "../consolidation/index.ts";
import type { ManagedAttempt } from "../work/index.ts";
import type { ReviewedPromotionAssembly } from "../artifact/index.ts";

export type ManagedProgramAuthority = {
  ledgerId: string;
  programId: string;
  manifestRevision: number;
  goalContractRef: ContentRef;
  authorityRef: ContentRef;
};

export type UnplannedManagedProgramState = ManagedProgramAuthority & {
  planningState: "unplanned";
};

export type ReviewedManagedProgramState = ManagedProgramAuthority & {
  planningState: "reviewed";
  plan: PlanningAcceptedProduct["candidate"]["plan"];
  planningReviewRef: ContentRef;
  works: ManagedWorkState[];
  tasks: ManagedTaskState[];
  currentWork: ManagedWorkState;
  currentTask: ManagedTaskState;
  criteria: PlanningAcceptedProduct["candidate"]["criteria"];
  verificationQuestions: PlanningAcceptedProduct["candidate"]["verificationQuestions"];
  artifactLifecycle: PlanningAcceptedProduct["candidate"]["artifactLifecycle"];
  promotionAssemblies: ReviewedPromotionAssembly[];
  promotionAuthorization?: PromotionAuthorizationProduct["authorization"];
  frontier: "implementation_open" | "awaiting_consolidation" | "promotion_open" | "closed";
  correctionPlanRef?: ContentRef;
};

export type ManagedProgramState =
  | UnplannedManagedProgramState
  | ReviewedManagedProgramState;

export type ManagedWorkState = {
  work: PlanningAcceptedProduct["candidate"]["works"][number];
  status: "planned" | "active" | "closed";
};

export type ManagedTaskState = {
  task: PlanningAcceptedProduct["candidate"]["tasks"][number];
  status: "planned" | "selected" | "result_submitted" | "review_failed" | "accepted";
  attempts: ManagedAttempt[];
  currentResult?: ResultCandidateProduct;
  currentReview?: TaskReviewProduct;
};

export type WorkLedgerCursor = {
  ledgerId: string;
  programId: string;
  expectedManifestRevision: number;
};

export type WorkLedgerMutation =
  | {
      kind: "bind_program";
      sessionId: string;
      product: GoalContractAcceptedProduct;
    }
  | { kind: "install_reviewed_plan"; product: PlanningAcceptedProduct }
  | { kind: "select_attempt"; cursor: WorkLedgerCursor; attempt: ManagedAttempt }
  | {
      kind: "attach_result";
      cursor: WorkLedgerCursor;
      product: ResultCandidateProduct;
    }
  | {
      kind: "attach_review";
      cursor: WorkLedgerCursor;
      product: TaskReviewProduct;
    }
  | {
      kind: "accept_feedback_plan";
      cursor: WorkLedgerCursor;
      product: FeedbackPlanningAcceptedProduct;
    }
  | {
      kind: "close_implementation_frontier";
      cursor: WorkLedgerCursor;
      promotionAssemblies: ReviewedPromotionAssembly[];
    }
  | {
      kind: "authorize_promotion";
      cursor: WorkLedgerCursor;
      product: PromotionAuthorizationProduct;
    }
  | {
      kind: "close_promotion_frontier";
      cursor: WorkLedgerCursor;
    };

export type WorkLedgerCommit = {
  mutationId: string;
  turnId: string;
  expectedTurnRevision: number;
  mutation: WorkLedgerMutation;
};

export interface WorkLedgerStorage {
  commit(input: WorkLedgerCommit): void;
  loadProgram(programId: string): ManagedProgramState | null;
}

export interface WorkLedger {
  commitAcceptedBoundary(input: WorkLedgerCommit): ManagedProgramState | null;
  loadProgram(programId: string): ManagedProgramState | null;
}
