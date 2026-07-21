import type {
  FeedbackIntentProduct,
  GoalContractAcceptedProduct,
  GoalContractCandidateProduct,
  OpeningContinuationProduct,
} from "../conception/index.ts";
import type { FinalDossierProduct } from "../consolidation/index.ts";
import type { ContentRef } from "../core/index.ts";
import type { ResultCandidateProduct } from "../execution/index.ts";
import type {
  FeedbackPlanProduct,
  FeedbackPlanningAcceptedProduct,
  PlanningAcceptedProduct,
  PlanningCandidateProduct,
} from "../planning/index.ts";
import type { PreparedReportProduct } from "../reporting/index.ts";
import type { TaskReviewProduct } from "../review/index.ts";
import type { ManagedAttempt } from "../work/index.ts";

export type ManagedProgramState = {
  ledgerId: string;
  programId: string;
  goalContractRef: ContentRef;
  authorityRef: ContentRef;
  plan: PlanningAcceptedProduct["candidate"]["plan"];
  planningReviewRef: ContentRef;
  work: PlanningAcceptedProduct["candidate"]["work"];
  task: PlanningAcceptedProduct["candidate"]["task"];
  criterion: PlanningAcceptedProduct["candidate"]["criterion"];
  verificationQuestion: PlanningAcceptedProduct["candidate"]["verificationQuestion"];
  artifactLifecycle: PlanningAcceptedProduct["candidate"]["artifactLifecycle"];
  frontier: "implementation_open" | "closed";
  workStatus: "planned" | "active" | "closed";
  taskStatus: "planned" | "selected" | "result_submitted" | "review_failed" | "accepted";
  attempts: ManagedAttempt[];
  currentResult?: ResultCandidateProduct;
  currentReview?: TaskReviewProduct;
  correctionPlanRef?: ContentRef;
};

export type ManagedTurnState = {
  opening?: OpeningContinuationProduct;
  goalCandidate?: GoalContractCandidateProduct;
  goalAcceptance?: GoalContractAcceptedProduct;
  planCandidate?: PlanningCandidateProduct;
  planningAcceptance?: PlanningAcceptedProduct;
  program?: ManagedProgramState;
  feedbackIntent?: FeedbackIntentProduct;
  feedbackPlan?: FeedbackPlanProduct;
  feedbackAcceptance?: FeedbackPlanningAcceptedProduct;
  finalDossier?: FinalDossierProduct;
  preparedReport?: PreparedReportProduct;
};

export function requireManagedState(turn: {
  semanticState: string;
  managed?: ManagedTurnState;
}): ManagedTurnState {
  if (!turn.managed) {
    throw new Error(`Managed BTCC state is missing at ${turn.semanticState}`);
  }
  return turn.managed;
}

export function requireManagedProgram(turn: {
  semanticState: string;
  managed?: ManagedTurnState;
}): ManagedProgramState {
  const program = requireManagedState(turn).program;
  if (!program) throw new Error(`Managed Program is missing at ${turn.semanticState}`);
  return program;
}

export function requireCurrentAttempt(program: ManagedProgramState): ManagedAttempt {
  const attempt = program.attempts.at(-1);
  if (!attempt || attempt.status !== "ready") {
    throw new Error("Task Execution requires the current ready Attempt");
  }
  return attempt;
}
