import type { PhaseInvocation } from "../core/index.ts";
import { withPhaseState } from "../core/index.ts";
import {
  requireManagedProgram,
  requireManagedPlanningAuthority,
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
    | "PlanningReviewAccepted"
    | "PlanningRevisionRequested";
}>;
type FeedbackPlanningEvent = Extract<TurnEvent, {
  kind:
    | "FeedbackPlanCandidateSubmitted"
    | "FeedbackPlanningReviewAccepted"
    | "FeedbackPlanningRevisionRequested";
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
    const authority = requireManagedPlanningAuthority(command.turn);
    const previous = managed.planningRevision;
    const product = await proposePlan(withPhaseState(command.phase, {
      goalContractRef: authority.goalContractRef,
      authorityRef: authority.authorityRef,
      requiredOutcomeId: accepted.goalContract.requiredOutcome.outcomeId,
      ledgerId: authority.ledgerId,
      programId: authority.programId,
      observedManifestRevision: authority.manifestRevision,
      ...(previous
        ? {
            previousCandidateRef: previous.candidate.ref,
            findingSetRef: previous.review.findingSetRef,
          }
        : {}),
    }));
    return { kind: "PlanCandidateSubmitted", product };
  }
  if (command.turn.semanticState === "planning_review") {
    const product = await reviewPlan(withPhaseState(command.phase, {
      planCandidate: managed.planCandidate,
    }));
    return product.kind === "planning_accepted"
      ? { kind: "PlanningReviewAccepted", product }
      : { kind: "PlanningRevisionRequested", product };
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
    const accepted = managed.goalAcceptance;
    if (!accepted) throw new Error("Feedback Planning is missing Goal authority");
    const previous = managed.feedbackPlanningRevision;
    const product = await proposeCorrectionOrRevision(withPhaseState(command.phase, {
      feedbackIntent: managed.feedbackIntent,
      workPlanRef: program.plan.ref,
      taskRef: program.currentTask.task.ref,
      artifactLifecycleRef: program.artifactLifecycle.ref,
      goalContractRef: program.goalContractRef,
      authorityRef: program.authorityRef,
      requiredOutcomeId: accepted.goalContract.requiredOutcome.outcomeId,
      ledgerId: program.ledgerId,
      programId: program.programId,
      observedManifestRevision: program.manifestRevision,
      currentTasks: program.tasks.map((task) => task.task),
      ...(previous
        ? {
            previousCandidateRef: previous.candidate.ref,
            findingSetRef: previous.review.findingSetRef,
          }
        : {}),
    }));
    return { kind: "FeedbackPlanCandidateSubmitted", product };
  }
  if (command.turn.semanticState === "feedback_planning_review") {
    const product = await reviewCorrection(withPhaseState(command.phase, {
      feedbackPlan: managed.feedbackPlan,
      goalContractRef: program.goalContractRef,
    }));
    return product.kind === "feedback_planning_accepted"
      ? { kind: "FeedbackPlanningReviewAccepted", product }
      : { kind: "FeedbackPlanningRevisionRequested", product };
  }
  throw new Error(`Feedback Planning cannot advance ${command.turn.semanticState}`);
}
