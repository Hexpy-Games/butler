import type { PhaseInvocation } from "../core/index.ts";
import { withPhaseState } from "../core/index.ts";
import {
  requireManagedProgram,
  requireManagedState,
  type TurnEvent,
  type TurnRecord,
} from "../turn/index.ts";
import { proposeCorrectionOrRevision } from "./plan-correction.ts";
import { proposePlan } from "./propose-plan.ts";
import { reviewCorrection } from "./review-correction.ts";
import { reviewPlan } from "./review-plan.ts";

type InitialPlanningEvent = Extract<TurnEvent, {
  kind:
    | "PlanCandidateSubmitted"
    | "PlanningReviewAccepted";
}>;
type FeedbackPlanningEvent = Extract<TurnEvent, {
  kind: "FeedbackPlanCandidateSubmitted" | "FeedbackPlanningReviewAccepted";
}>;
type PlanningCommand = {
  cycle: "initial" | "review_feedback";
  turn: TurnRecord;
  phase: PhaseInvocation;
};

export function planning(command: {
  cycle: "initial";
  turn: TurnRecord;
  phase: PhaseInvocation;
}): Promise<InitialPlanningEvent>;
export function planning(command: {
  cycle: "review_feedback";
  turn: TurnRecord;
  phase: PhaseInvocation;
}): Promise<FeedbackPlanningEvent>;
export function planning(
  command: PlanningCommand,
): Promise<InitialPlanningEvent | FeedbackPlanningEvent> {
  return command.cycle === "initial"
    ? planInitialWork(command)
    : planReviewFeedback(command);
}

async function planInitialWork(command: {
  turn: TurnRecord;
  phase: PhaseInvocation;
}): Promise<InitialPlanningEvent> {
  const managed = requireManagedState(command.turn);
  if (command.turn.semanticState === "planning") {
    const accepted = managed.goalAcceptance;
    if (!accepted) throw new Error("Planning is missing accepted Goal authority");
    const product = await proposePlan(withPhaseState(command.phase, {
      goalContractRef: accepted.goalContract.ref,
      authorityRef: accepted.authority.ref,
      requiredOutcomeId: accepted.goalContract.requiredOutcome.outcomeId,
      ledgerId: accepted.authority.managedBinding.ledgerId,
      programId: accepted.authority.managedBinding.programId,
    }));
    return { kind: "PlanCandidateSubmitted", product };
  }
  if (command.turn.semanticState === "planning_review") {
    const product = await reviewPlan(withPhaseState(command.phase, {
      planCandidate: managed.planCandidate,
    }));
    return { kind: "PlanningReviewAccepted", product };
  }
  throw new Error(`Initial Planning cannot advance ${command.turn.semanticState}`);
}

async function planReviewFeedback(command: {
  turn: TurnRecord;
  phase: PhaseInvocation;
}): Promise<FeedbackPlanningEvent> {
  const managed = requireManagedState(command.turn);
  const program = requireManagedProgram(command.turn);
  if (command.turn.semanticState === "feedback_planning") {
    const product = await proposeCorrectionOrRevision(withPhaseState(command.phase, {
      feedbackIntent: managed.feedbackIntent,
      workPlanRef: program.plan.ref,
      taskRef: program.task.ref,
      artifactLifecycleRef: program.artifactLifecycle.ref,
    }));
    return { kind: "FeedbackPlanCandidateSubmitted", product };
  }
  if (command.turn.semanticState === "feedback_planning_review") {
    const product = await reviewCorrection(withPhaseState(command.phase, {
      feedbackPlan: managed.feedbackPlan,
      goalContractRef: program.goalContractRef,
    }));
    return { kind: "FeedbackPlanningReviewAccepted", product };
  }
  throw new Error(`Feedback Planning cannot advance ${command.turn.semanticState}`);
}
