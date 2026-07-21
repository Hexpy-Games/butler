import type { PhaseInvocation } from "../core/index.ts";
import { withPhaseState } from "../core/index.ts";
import {
  requireManagedProgram,
  requireManagedState,
  type TurnEvent,
  type TurnRecord,
} from "../turn/index.ts";
import { conceiveCorrection } from "./conceive-correction.ts";
import { deliberateGoal } from "./deliberate-goal.ts";
import { openConception } from "./opening/open-conception.ts";
import { reviewGoalContract } from "./review-goal-contract.ts";

type InitialConceptionEvent = Extract<TurnEvent, {
  kind:
    | "OpeningAnswerAccepted"
    | "OpeningContinuationAccepted"
    | "GoalContractCandidateSubmitted"
    | "GoalContractReviewAccepted";
}>;
type FeedbackConceptionEvent = Extract<TurnEvent, { kind: "FeedbackIntentAccepted" }>;
type ConceptionCommand = {
  cycle: "initial" | "review_feedback";
  turn: TurnRecord;
  phase: PhaseInvocation;
};

export function conception(command: {
  cycle: "initial";
  turn: TurnRecord;
  phase: PhaseInvocation;
}): Promise<InitialConceptionEvent>;
export function conception(command: {
  cycle: "review_feedback";
  turn: TurnRecord;
  phase: PhaseInvocation;
}): Promise<FeedbackConceptionEvent>;
export function conception(
  command: ConceptionCommand,
): Promise<InitialConceptionEvent | FeedbackConceptionEvent> {
  return command.cycle === "review_feedback"
    ? conceiveReviewFeedback(command)
    : conceiveInitialGoal(command);
}

async function conceiveInitialGoal(command: {
  turn: TurnRecord;
  phase: PhaseInvocation;
}): Promise<InitialConceptionEvent> {
  switch (command.turn.semanticState) {
    case "conception_opening": {
      const product = await openConception(command.phase);
      return product.kind === "opening_answer"
        ? { kind: "OpeningAnswerAccepted", product }
        : { kind: "OpeningContinuationAccepted", product };
    }
    case "conception_deliberation": {
      const product = await deliberateGoal(command.phase);
      return { kind: "GoalContractCandidateSubmitted", product };
    }
    case "contract_review": {
      const product = await reviewGoalContract(withPhaseState(command.phase, {
        sessionId: command.turn.sessionId,
        goalCandidate: requireManagedState(command.turn).goalCandidate,
      }));
      return { kind: "GoalContractReviewAccepted", product };
    }
    default:
      throw new Error(`Conception cannot advance ${command.turn.semanticState}`);
  }
}

async function conceiveReviewFeedback(command: {
  turn: TurnRecord;
  phase: PhaseInvocation;
}): Promise<FeedbackConceptionEvent> {
  const program = requireManagedProgram(command.turn);
  const review = program.currentReview;
  if (!review || review.review.verdict !== "not_passed") {
    throw new Error("Feedback Conception requires a failed Task Review");
  }
  const product = await conceiveCorrection(withPhaseState(command.phase, {
    correctionScopeRef: review.review.correctionScopeRef,
    goalContractRef: program.goalContractRef,
    authorityRef: program.authorityRef,
  }));
  return { kind: "FeedbackIntentAccepted", product };
}
