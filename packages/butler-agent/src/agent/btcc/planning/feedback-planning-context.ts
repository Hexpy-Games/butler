import type { GoalContractAcceptedProduct } from "../conception/index.ts";
import type { ContentRef } from "../core/index.ts";
import type { ManagedTurnState } from "../turn/index.ts";
import type { ReviewedManagedProgramState } from "../work-ledger/index.ts";
import { projectReviewValidationSource } from "../review/index.ts";

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
  const currentResult = program.currentTask.currentResult;
  if (!currentResult) {
    throw new Error("Feedback Planning is missing the current ResultCandidate");
  }
  const affectedTaskRefs = managed.consolidationRepair?.repair.correctionScope.affectedTaskRefs
    ?? [program.currentTask.task.ref];
  const selectedSpecs = specsForTask(program, program.currentTask.task.governingSpecRefs);
  const acceptedPlan = currentAcceptedPlan(program, managed);
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
    requiredOutcomeId: acceptedPlanRequiredOutcomeId(acceptedPlan),
    artifactPersistence: accepted.goalContract.artifactPersistence,
    ...projectReviewValidationSource(currentResult.result),
    ...revisionContext(managed),
  };
  if (feedbackIntent.feedbackIntent.correctionKind === "implementation_repair") {
    return common;
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

function acceptedPlanRequiredOutcomeId(
  plan: ReviewedManagedProgramState["acceptedPlan"],
): string {
  const ids = new Set(
    plan.criteria.flatMap((criterion) => criterion.sourceRequiredOutcomeRefs),
  );
  if (ids.size !== 1) {
    throw new Error("Feedback Planning accepted Plan has ambiguous outcome lineage");
  }
  return [...ids][0]!;
}

function currentAcceptedPlan(
  program: ReviewedManagedProgramState,
  managed: ManagedTurnState,
) {
  if (program.acceptedPlan) return program.acceptedPlan;
  const feedback = managed.feedbackAcceptance?.candidate;
  if (
    feedback?.correctionKind === "governing_revision" ||
    feedback?.correctionKind === "authority_scope_revision"
  ) {
    return feedback.nextPlanCandidate;
  }
  const initial = managed.planningAcceptance?.candidate;
  if (!initial) throw new Error("Feedback Planning is missing current Plan authority");
  return initial;
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
        previousFeedbackPlanningReview: previous.review,
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
