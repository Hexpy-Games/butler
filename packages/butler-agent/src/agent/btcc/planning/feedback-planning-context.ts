import type { GoalContractAcceptedProduct } from "../conception/index.ts";
import type { ContentRef } from "../core/index.ts";
import type { ManagedTurnState } from "../turn/index.ts";
import type { ReviewedManagedProgramState } from "../work-ledger/index.ts";

type FeedbackPlanningContextInput = {
  accepted: GoalContractAcceptedProduct;
  managed: ManagedTurnState;
  program: ReviewedManagedProgramState;
};

export function projectFeedbackPlanningContext(
  input: FeedbackPlanningContextInput,
): Record<string, unknown> {
  const { accepted, managed, program } = input;
  const feedbackIntent = managed.feedbackIntent;
  if (!feedbackIntent) {
    throw new Error("Feedback Planning is missing the accepted FeedbackIntent");
  }
  const affectedTaskRefs = managed.consolidationRepair?.repair.correctionScope.affectedTaskRefs
    ?? [program.currentTask.task.ref];
  const selectedSpecs = specsForTask(program, program.currentTask.task.governingSpecRefs);
  const common = {
    acceptedGoalContract: accepted.goalContract,
    acceptedAuthority: accepted.authority,
    feedbackIntent,
    workPlanRef: program.plan.ref,
    affectedTaskRefs,
    artifactLifecycleRef: program.artifactLifecycle.ref,
    currentWork: program.currentWork.work,
    currentTask: program.currentTask.task,
    correctionSource: correctionSource(managed, program),
    governingSpecRefs: selectedSpecs.map((spec) => spec.revisionRef),
    governingSpecs: selectedSpecs,
    currentArtifactPolicy: program.artifactLifecycle.taskPolicies.find(
      (policy) => sameRef(policy.taskRef, program.currentTask.task.ref),
    ) ?? null,
    goalContractRef: program.goalContractRef,
    authorityRef: program.authorityRef,
    requiredOutcomeId: program.requiredOutcomeId,
    artifactPersistence: accepted.goalContract.artifactPersistence,
    ...revisionContext(managed),
  };
  if (feedbackIntent.feedbackIntent.correctionKind === "implementation_repair") {
    return common;
  }
  const acceptedPlan = managed.planningAcceptance?.candidate;
  if (!acceptedPlan) {
    throw new Error("Governing Feedback Planning requires the accepted semantic Plan");
  }
  return {
    ...common,
    ledgerId: program.ledgerId,
    ...(accepted.authority.ledgerScope.kind === "project"
      ? { specParentRootId: accepted.authority.ledgerScope.projectRef }
      : {}),
    programId: program.programId,
    observedManifestRevision: program.manifestRevision,
    governingSpecRefs: program.governingSpecRefs,
    governingSpecs: program.governingSpecs,
    availableSpecs: program.availableSpecs,
    requireGoverningSpec: accepted.authority.ledgerScope.kind === "project",
    acceptedPlan,
    taskImpactIndex: program.tasks.map((state) => ({
      task: {
        ref: state.task.ref,
        taskLogicalId: state.task.taskLogicalId,
      },
      status: state.status,
      hasCurrentResult: Boolean(state.currentResult),
    })),
  };
}

function correctionSource(
  managed: ManagedTurnState,
  program: ReviewedManagedProgramState,
) {
  const source = managed.consolidationRepair?.repair ?? program.currentTask.currentReview;
  if (!source) throw new Error("Feedback Planning is missing its correction source");
  return source;
}

function specsForTask(
  program: ReviewedManagedProgramState,
  refs: ContentRef[],
) {
  const selected = new Set(refs.map(refKey));
  return program.governingSpecs.filter((spec) => selected.has(refKey(spec.revisionRef)));
}

function revisionContext(managed: ManagedTurnState): Record<string, unknown> {
  const previous = managed.feedbackPlanningRevision;
  return previous
    ? {
        previousCandidateRef: previous.candidate.ref,
        findingSetRef: previous.review.findingSetRef,
        previousFeedbackPlan: previous.candidate,
        feedbackPlanningReviewFindings: previous.review.findings,
      }
    : {};
}

function sameRef(left: ContentRef, right: ContentRef): boolean {
  return refKey(left) === refKey(right);
}

function refKey(ref: ContentRef): string {
  return `${ref.id}\0${ref.sha256}`;
}
