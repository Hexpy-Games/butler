import type {
  FeedbackIntentProduct,
  GoalContractAcceptedProduct,
  GoalContractCandidateProduct,
  GoalContractRevisionRequiredProduct,
  OpeningContinuationProduct,
} from "../conception/index.ts";
import type {
  ConsolidationRepairProduct,
  FinalDossierProduct,
} from "../consolidation/index.ts";
import type {
  FeedbackPlanProduct,
  FeedbackPlanningAcceptedProduct,
  FeedbackPlanningRevisionRequiredProduct,
  PlanningAcceptedProduct,
  PlanningCandidateProduct,
  PlanningRevisionRequiredProduct,
} from "../planning/index.ts";
import type { PreparedReportProduct } from "../reporting/index.ts";
import type {
  ManagedProgramState,
  ReviewedManagedProgramState,
} from "../work-ledger/index.ts";
import type { ManagedAttempt } from "../work/index.ts";
import type { ManagedDeferralProduct } from "../deferral/index.ts";

export type ManagedTurnState = {
  programId?: string;
  opening?: OpeningContinuationProduct;
  goalCandidate?: GoalContractCandidateProduct;
  goalRevision?: GoalContractRevisionRequiredProduct;
  goalAcceptance?: GoalContractAcceptedProduct;
  planCandidate?: PlanningCandidateProduct;
  planningRevision?: PlanningRevisionRequiredProduct;
  planningAcceptance?: PlanningAcceptedProduct;
  program?: ManagedProgramState;
  feedbackIntent?: FeedbackIntentProduct;
  feedbackPlan?: FeedbackPlanProduct;
  feedbackPlanningRevision?: FeedbackPlanningRevisionRequiredProduct;
  feedbackAcceptance?: FeedbackPlanningAcceptedProduct;
  deferral?: ManagedDeferralProduct;
  consolidationRepair?: ConsolidationRepairProduct;
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
}): ReviewedManagedProgramState {
  const program = requireManagedState(turn).program;
  if (!program) throw new Error(`Managed Program is missing at ${turn.semanticState}`);
  if (program.planningState !== "reviewed") {
    throw new Error(`Managed Program has no reviewed Plan at ${turn.semanticState}`);
  }
  return program;
}

export function requireManagedPlanningAuthority(turn: {
  semanticState: string;
  managed?: ManagedTurnState;
}): ManagedProgramState {
  const program = requireManagedState(turn).program;
  if (!program) throw new Error(`Managed Program authority is missing at ${turn.semanticState}`);
  return program;
}

export function requireCurrentAttempt(program: ReviewedManagedProgramState): ManagedAttempt {
  const attempt = program.currentTask.attempts.at(-1);
  if (!attempt || attempt.status !== "ready") {
    throw new Error("Task Execution requires the current ready Attempt");
  }
  return attempt;
}

export type { ManagedProgramState } from "../work-ledger/index.ts";
