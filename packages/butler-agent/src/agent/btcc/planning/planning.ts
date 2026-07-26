import type { PhaseInvocation } from "../core/index.ts";
import { isManagedDeferral, withManagedDeferralState } from "../deferral/index.ts";
import {
  requireManagedProgram,
  requireManagedPlanningAuthority,
  requireManagedState,
  type TurnEvent,
  type TurnRecord,
} from "../turn/index.ts";
import {
  projectReviewValidationSource,
  taskReviewAuthority,
} from "../review/index.ts";
import { proposeCorrectionOrRevision } from "./plan-correction.ts";
import { projectFeedbackPlanningContext } from "./feedback-planning-context.ts";
import { proposePlan } from "./propose-plan.ts";
import { reviewCorrection } from "./review-correction.ts";
import { reviewPlan } from "./review-plan.ts";
import type {
  GoverningSpecRevision,
  PlanningCandidateProduct,
} from "./contracts.ts";
import type { PlanningRevisionRequiredProduct } from "./review-contracts.ts";
import {
  admitPlanningObservations,
  mergePlanningObservationIndexes,
} from "./observation-result-index.ts";

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
  const observations = mergePlanningObservationIndexes(
    accepted.planningContext.observationResultIndex,
    previous?.observationResultIndex ?? [],
  );
  const phase = admitPlanningObservations(
    command.phase,
    observations,
  );
  const product = await proposePlan(withManagedDeferralState(phase, command.turn, {
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
    governingSpecs: authority.governingSpecs,
    availableSpecs: authority.availableSpecs,
    requireGoverningSpec: accepted.authority.ledgerScope.kind === "project",
    priorPlanningObservationResultIndex: observations,
    ...(accepted.authority.managedBinding.continuationBinding.kind !== "new_request"
      ? { continuation: accepted.authority.managedBinding.continuationBinding }
      : {}),
    ...projectPlanningRevision(previous),
  }));
  return isManagedDeferral(product)
    ? { kind: "ManagedDeferralAccepted", product }
    : { kind: "PlanCandidateSubmitted", product };
}

export function projectPlanningRevision(
  previous: PlanningRevisionRequiredProduct | undefined,
) {
  if (!previous) return {};
  return {
    previousPlanCandidate: previous.candidate,
    planningReviewFindings: previous.review.findings,
    previousCandidateRef: previous.candidate.ref,
    findingSetRef: previous.review.findingSetRef,
    priorPlanningReview: previous.review,
  };
}

async function reviewInitialPlan(command: {
  turn: TurnRecord;
  phase: PhaseInvocation;
}): Promise<InitialPlanningEvent> {
  const managed = requireManagedState(command.turn);
  const accepted = managed.goalAcceptance;
  if (!accepted) throw new Error("Planning Review is missing accepted Goal authority");
  const current = requireManagedPlanningAuthority(command.turn);
  const product = await reviewPlan(withManagedDeferralState(command.phase, command.turn, {
    acceptedGoalContract: accepted.goalContract,
    acceptedAuthority: accepted.authority,
    currentPlanningAuthority: {
      goalContractRef: current.goalContractRef,
      authorityRef: current.authorityRef,
      requiredOutcomeId: current.requiredOutcomeId,
      ledgerId: current.ledgerId,
      programId: current.programId,
      manifestRevision: current.manifestRevision,
      governingSpecRefs: current.governingSpecRefs,
      governingSpecs: governingSpecsForReview(current.governingSpecs, managed.planCandidate),
    },
    planCandidate: managed.planCandidate,
    ...(managed.planningRevision
      ? { priorPlanningReview: managed.planningRevision.review }
      : {}),
  }));
  if (isManagedDeferral(product)) return { kind: "ManagedDeferralAccepted", product };
  return product.kind === "planning_accepted"
    ? { kind: "PlanningReviewAccepted", product }
    : { kind: "PlanningRevisionRequested", product };
}

function governingSpecsForReview(
  accepted: GoverningSpecRevision[],
  product: PlanningCandidateProduct | undefined,
): GoverningSpecRevision[] {
  if (!product || "validationFindings" in product.candidate) {
    return accepted;
  }
  const candidate = product.candidate;
  const byRef = new Map(accepted.map((spec) => [refKey(spec.revisionRef), spec]));
  for (const spec of candidate.authoredSpecs) {
    byRef.set(refKey(spec.ref), {
      logicalId: spec.logicalId,
      parentId: spec.parentId,
      concernId: spec.concernId,
      title: spec.title,
      status: "specified",
      revisionRef: spec.ref,
      body: spec.body,
    });
  }
  return candidate.governingSpecRefs.flatMap((ref) => {
    const spec = byRef.get(refKey(ref));
    return spec ? [spec] : [];
  });
}

function refKey(ref: { id: string; sha256: string }): string {
  return `${ref.id}:${ref.sha256}`;
}

async function authorFeedbackPlan(command: {
  turn: TurnRecord;
  phase: PhaseInvocation;
}): Promise<FeedbackPlanningEvent> {
  const managed = requireManagedState(command.turn);
  const program = requireManagedProgram(command.turn);
  const accepted = managed.goalAcceptance;
  if (!accepted) throw new Error("Feedback Planning is missing Goal authority");
  const currentResult = program.currentTask.currentResult;
  if (!currentResult) throw new Error("Feedback Planning is missing the current ResultCandidate");
  const invocation = withManagedDeferralState(
    command.phase,
    command.turn,
    projectFeedbackPlanningContext({ managed, program, accepted }),
  );
  const product = await proposeCorrectionOrRevision({
    ...invocation,
    operationAuthority: taskReviewAuthority({
      baseline: command.phase.operationAuthority,
      result: currentResult.result,
    }),
  });
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
  const currentResult = program.currentTask.currentResult;
  if (!currentResult) {
    throw new Error("Feedback Planning Review is missing the current ResultCandidate");
  }
  const invocation = withManagedDeferralState(
    command.phase,
    command.turn,
    projectFeedbackReviewInput(managed, program, accepted),
  );
  const product = await reviewCorrection({
    ...invocation,
    operationAuthority: taskReviewAuthority({
      baseline: command.phase.operationAuthority,
      result: currentResult.result,
    }),
  });
  if (isManagedDeferral(product)) return { kind: "ManagedDeferralAccepted", product };
  return product.kind === "feedback_planning_accepted"
    ? { kind: "FeedbackPlanningReviewAccepted", product }
    : { kind: "FeedbackPlanningRevisionRequested", product };
}

function projectFeedbackReviewInput(
  managed: ReturnType<typeof requireManagedState>,
  program: ReturnType<typeof requireManagedProgram>,
  accepted: NonNullable<ReturnType<typeof requireManagedState>["goalAcceptance"]>,
) {
  const currentAttempt = program.currentTask.attempts.at(-1);
  if (!currentAttempt) {
    throw new Error("Feedback Planning Review is missing the current Attempt");
  }
  const currentResult = program.currentTask.currentResult;
  if (!currentResult) {
    throw new Error("Feedback Planning Review is missing the current ResultCandidate");
  }
  const feedbackIntent = managed.feedbackIntent;
  if (!feedbackIntent) {
    throw new Error("Feedback Planning Review is missing the accepted FeedbackIntent");
  }
  const feedbackPlan = managed.feedbackPlan;
  if (!feedbackPlan) {
    throw new Error("Feedback Planning Review is missing the exact FeedbackPlan candidate");
  }
  const correctionSource = managed.consolidationRepair?.repair
    ?? program.currentTask.currentReview;
  if (!correctionSource) {
    throw new Error("Feedback Planning Review is missing its correction source");
  }
  return {
    acceptedGoalContract: accepted.goalContract,
    acceptedAuthority: accepted.authority,
    acceptedPlanRef: program.plan.ref,
    governingSpecRefs: program.governingSpecRefs,
    governingSpecs: program.governingSpecs,
    currentWork: program.currentWork.work,
    currentTask: program.currentTask.task,
    currentAttempt,
    currentResult,
    ...projectReviewValidationSource(currentResult.result),
    correctionSource,
    feedbackIntent,
    feedbackPlan,
    artifactLifecycle: program.artifactLifecycle,
    ...(managed.feedbackPlanningRevision
      ? { previousFeedbackPlanningReview: managed.feedbackPlanningRevision.review }
      : {}),
    goalContractRef: program.goalContractRef,
  };
}
