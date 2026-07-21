import type {
  FeedbackIntentProduct,
  GoalContractAcceptedProduct,
  GoalContractCandidateProduct,
  OpeningContinuationProduct,
} from "../conception/index.ts";
import type { FinalDossierProduct } from "../consolidation/index.ts";
import type {
  FeedbackPlanProduct,
  FeedbackPlanningAcceptedProduct,
  PlanningAcceptedProduct,
  PlanningCandidateProduct,
} from "../planning/index.ts";
import type { PreparedReportProduct } from "../reporting/index.ts";
import type { ManagedProgramState } from "../work-ledger/index.ts";
import type { ManagedAttempt } from "../work/index.ts";

export type ManagedTurnState = {
  programId?: string;
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

export type { ManagedProgramState } from "../work-ledger/index.ts";
