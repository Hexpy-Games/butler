import type { PhaseInvocation } from "../core/index.ts";
import { isManagedDeferral, withManagedDeferralState } from "../deferral/index.ts";
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
    | "PlanningRevisionRequested"
    | "ManagedDeferralAccepted";
}>;
type FeedbackPlanningEvent = Extract<TurnEvent, {
  kind:
    | "FeedbackPlanCandidateSubmitted"
    | "FeedbackPlanningReviewAccepted"
    | "FeedbackPlanningRevisionRequested"
    | "ManagedDeferralAccepted";
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
  switch (command.turn.semanticState) {
    case "planning":
      return authorInitialPlan(command);
    case "planning_review":
      return reviewInitialPlan(command);
    default:
      throw new Error(`Initial Planning cannot advance ${command.turn.semanticState}`);
  }
}

async function planReviewFeedback(command: {
  turn: TurnRecord;
  phase: PhaseInvocation;
}): Promise<FeedbackPlanningEvent> {
  switch (command.turn.semanticState) {
    case "feedback_planning":
      return authorFeedbackPlan(command);
    case "feedback_planning_review":
      return reviewFeedbackPlan(command);
    default:
      throw new Error(`Feedback Planning cannot advance ${command.turn.semanticState}`);
  }
}

async function authorInitialPlan(command: {
  turn: TurnRecord;
  phase: PhaseInvocation;
}): Promise<InitialPlanningEvent> {
  const managed = requireManagedState(command.turn);
  const accepted = managed.goalAcceptance;
  if (!accepted) throw new Error("Planning is missing accepted Goal authority");
  const authority = requireManagedPlanningAuthority(command.turn);
  const previous = managed.planningRevision;
  const product = await proposePlan(withManagedDeferralState(command.phase, command.turn, {
    acceptedGoalContract: accepted.goalContract,
    acceptedAuthority: accepted.authority,
    goalContractRef: authority.goalContractRef,
    authorityRef: authority.authorityRef,
    requiredOutcomeId: authority.requiredOutcomeId,
    artifactPersistence: accepted.goalContract.artifactPersistence,
    ledgerId: authority.ledgerId,
    ...(specParentRootId(accepted.authority) ? {
      specParentRootId: specParentRootId(accepted.authority),
    } : {}),
    programId: authority.programId,
    observedManifestRevision: authority.manifestRevision,
    governingSpecRefs: authority.governingSpecRefs,
    availableSpecs: authority.availableSpecs,
    requireGoverningSpec: accepted.authority.ledgerScope.kind === "project",
    ...(accepted.authority.managedBinding.continuationBinding.kind === "deferred_goal"
      ? { continuation: accepted.authority.managedBinding.continuationBinding }
      : {}),
    ...(previous
      ? {
          previousCandidateRef: previous.candidate.ref,
          findingSetRef: previous.review.findingSetRef,
          previousPlanCandidate: previous.candidate,
          planningReviewFindings: previous.review.findings,
        }
      : {}),
  }));
  return isManagedDeferral(product)
    ? { kind: "ManagedDeferralAccepted", product }
    : { kind: "PlanCandidateSubmitted", product };
}

async function reviewInitialPlan(command: {
  turn: TurnRecord;
  phase: PhaseInvocation;
}): Promise<InitialPlanningEvent> {
  const managed = requireManagedState(command.turn);
  const accepted = managed.goalAcceptance;
  if (!accepted) throw new Error("Planning Review is missing accepted Goal authority");
  const product = await reviewPlan(withManagedDeferralState(command.phase, command.turn, {
    acceptedGoalContract: accepted.goalContract,
    acceptedAuthority: accepted.authority,
    planCandidate: managed.planCandidate,
  }));
  if (isManagedDeferral(product)) return { kind: "ManagedDeferralAccepted", product };
  return product.kind === "planning_accepted"
    ? { kind: "PlanningReviewAccepted", product }
    : { kind: "PlanningRevisionRequested", product };
}

async function authorFeedbackPlan(command: {
  turn: TurnRecord;
  phase: PhaseInvocation;
}): Promise<FeedbackPlanningEvent> {
  const managed = requireManagedState(command.turn);
  const program = requireManagedProgram(command.turn);
  if (!managed.goalAcceptance) throw new Error("Feedback Planning is missing Goal authority");
  const previous = managed.feedbackPlanningRevision;
  const affectedTaskRefs = managed.consolidationRepair?.repair.correctionScope.affectedTaskRefs
    ?? [program.currentTask.task.ref];
  const product = await proposeCorrectionOrRevision(withManagedDeferralState(
    command.phase,
    command.turn,
    {
      acceptedGoalContract: managed.goalAcceptance.goalContract,
      acceptedAuthority: managed.goalAcceptance.authority,
      feedbackIntent: managed.feedbackIntent,
      workPlanRef: program.plan.ref,
      affectedTaskRefs,
      artifactLifecycleRef: program.artifactLifecycle.ref,
      goalContractRef: program.goalContractRef,
      authorityRef: program.authorityRef,
      requiredOutcomeId: program.requiredOutcomeId,
      artifactPersistence: managed.goalAcceptance.goalContract.artifactPersistence,
      ledgerId: program.ledgerId,
      ...(specParentRootId(managed.goalAcceptance.authority) ? {
        specParentRootId: specParentRootId(managed.goalAcceptance.authority),
      } : {}),
      programId: program.programId,
      observedManifestRevision: program.manifestRevision,
      governingSpecRefs: program.governingSpecRefs,
      availableSpecs: program.availableSpecs,
      requireGoverningSpec: managed.goalAcceptance.authority.ledgerScope.kind === "project",
      currentTasks: program.tasks.map((task) => task.task),
      ...(previous
        ? {
            previousCandidateRef: previous.candidate.ref,
            findingSetRef: previous.review.findingSetRef,
            previousFeedbackPlan: previous.candidate,
            feedbackPlanningReviewFindings: previous.review.findings,
          }
        : {}),
    },
  ));
  return isManagedDeferral(product)
    ? { kind: "ManagedDeferralAccepted", product }
    : { kind: "FeedbackPlanCandidateSubmitted", product };
}

function specParentRootId(
  authority: NonNullable<ReturnType<typeof requireManagedState>["goalAcceptance"]>["authority"],
): string | undefined {
  return authority.ledgerScope.kind === "project"
    ? authority.ledgerScope.projectRef
    : undefined;
}

async function reviewFeedbackPlan(command: {
  turn: TurnRecord;
  phase: PhaseInvocation;
}): Promise<FeedbackPlanningEvent> {
  const managed = requireManagedState(command.turn);
  const program = requireManagedProgram(command.turn);
  const accepted = managed.goalAcceptance;
  if (!accepted) throw new Error("Feedback Planning Review is missing accepted Goal authority");
  const product = await reviewCorrection(withManagedDeferralState(command.phase, command.turn, {
    acceptedGoalContract: accepted.goalContract,
    acceptedAuthority: accepted.authority,
    feedbackPlan: managed.feedbackPlan,
    goalContractRef: program.goalContractRef,
  }));
  if (isManagedDeferral(product)) return { kind: "ManagedDeferralAccepted", product };
  return product.kind === "feedback_planning_accepted"
    ? { kind: "FeedbackPlanningReviewAccepted", product }
    : { kind: "FeedbackPlanningRevisionRequested", product };
}
