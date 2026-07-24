import type {
  AvailableSpecRevision,
  FeedbackPlanningAcceptedProduct,
  GoverningSpecRevision,
  ManagedSpecRevision,
  PlanningAcceptedProduct,
} from "../planning/contracts.ts";
import type {
  ManagedProgramAuthority,
  ManagedProgramState,
  WorkLedgerMutation,
} from "./contracts.ts";
import { governingSpecLogicalIds } from "../conception/index.ts";

type BindProgram = Extract<WorkLedgerMutation, { kind: "bind_program" }>;

export function bindManagedProgram(
  current: ManagedProgramState | null,
  mutation: BindProgram,
  availableSpecs: AvailableSpecRevision[],
  governingSpecs: GoverningSpecRevision[] = [],
): ManagedProgramState {
  const { authority, goalContract } = mutation.product;
  const binding = authority.managedBinding;
  const governingLogicalIds = governingSpecLogicalIds(goalContract);
  const governingSpecRefs = resolveGoverningSpecRefs(
    governingLogicalIds,
    availableSpecs,
  );
  const nextAuthority = {
    ledgerId: binding.ledgerId,
    programId: binding.programId,
    goalContractRef: goalContract.ref,
    authorityRef: authority.ref,
    availableSpecs,
    availableSpecRefs: availableSpecs.map((spec) => spec.revisionRef),
    governingSpecs: selectGoverningSpecs(
      governingLogicalIds,
      governingSpecs,
    ),
    governingSpecRefs,
    requiredOutcomeId: goalContract.requiredOutcome.outcomeId,
  };
  if (!current) {
    assertNewProgramBinding(mutation);
    return {
      ...nextAuthority,
      manifestRevision: 1,
      planningState: "unplanned",
    };
  }
  assertDeferredContinuation(current, mutation);
  return {
    ...current,
    ...nextAuthority,
    manifestRevision: current.manifestRevision + 1,
  };
}

export function acceptReviewedPlanAuthority(
  current: ManagedProgramState,
  product: PlanningAcceptedProduct,
): ManagedProgramAuthority {
  const candidate = product.candidate;
  assertAcceptedReview(product);
  if (
    current.programId !== candidate.programId ||
    current.ledgerId !== candidate.ledgerId ||
    current.manifestRevision !== candidate.observedManifestRevision ||
    !sameRef(current.goalContractRef, candidate.goalContractRef) ||
    !sameRef(current.authorityRef, candidate.authorityRef)
  ) {
    throw new Error("Work Ledger reviewed Plan authority changed");
  }
  const availableSpecs = mergeAvailableSpecs(
    current.availableSpecs,
    candidate.authoredSpecs,
  );
  const availableRefs = new Set(availableSpecs.map((spec) => refKey(spec.revisionRef)));
  if (candidate.governingSpecRefs.some((ref) => !availableRefs.has(refKey(ref)))) {
    throw new Error("Work Ledger reviewed Plan selected unavailable governing authority");
  }
  return {
    ledgerId: current.ledgerId,
    programId: current.programId,
    manifestRevision: current.manifestRevision + 1,
    goalContractRef: current.goalContractRef,
    authorityRef: current.authorityRef,
    availableSpecs,
    availableSpecRefs: availableSpecs.map((spec) => spec.revisionRef),
    governingSpecs: selectAcceptedGoverningSpecs(current.governingSpecs ?? [], candidate),
    governingSpecRefs: candidate.governingSpecRefs,
    requiredOutcomeId: current.requiredOutcomeId,
  };
}

export function acceptFeedbackAuthority(
  current: ManagedProgramState,
  product: FeedbackPlanningAcceptedProduct,
): ManagedProgramAuthority {
  const candidate = product.candidate;
  assertAcceptedFeedbackReview(current, product);
  if (candidate.correctionKind === "implementation_repair") {
    return { ...current, manifestRevision: current.manifestRevision + 1 };
  }
  const plan = candidate.nextPlanCandidate;
  const authorityRef = candidate.correctionKind === "authority_scope_revision"
    ? candidate.proposedAuthority.ref
    : current.authorityRef;
  if (
    current.programId !== plan.programId ||
    current.ledgerId !== plan.ledgerId ||
    current.manifestRevision !== plan.observedManifestRevision ||
    !sameRef(current.goalContractRef, plan.goalContractRef) ||
    !sameRef(authorityRef, plan.authorityRef)
  ) {
    throw new Error("Work Ledger revised authority changed its accepted base");
  }
  const availableSpecs = mergeAvailableSpecs(current.availableSpecs, plan.authoredSpecs);
  const availableRefs = new Set(availableSpecs.map((spec) => refKey(spec.revisionRef)));
  if (plan.governingSpecRefs.some((ref) => !availableRefs.has(refKey(ref)))) {
    throw new Error("Work Ledger revised Plan selected unavailable governing authority");
  }
  return {
    ledgerId: current.ledgerId,
    programId: current.programId,
    manifestRevision: current.manifestRevision + 1,
    goalContractRef: current.goalContractRef,
    authorityRef,
    availableSpecs,
    availableSpecRefs: availableSpecs.map((spec) => spec.revisionRef),
    governingSpecs: selectAcceptedGoverningSpecs(current.governingSpecs ?? [], plan),
    governingSpecRefs: plan.governingSpecRefs,
    requiredOutcomeId: current.requiredOutcomeId,
  };
}

function assertNewProgramBinding(mutation: BindProgram): void {
  const binding = mutation.product.authority.managedBinding;
  if (
    binding.source !== "new_program" ||
    binding.expectedManifestRevision !== 0 ||
    binding.continuationBinding.kind !== "new_request"
  ) {
    throw new Error("Work Ledger new Program binding is invalid");
  }
}

function assertAcceptedReview(product: PlanningAcceptedProduct): void {
  const { candidate, review } = product;
  if (
    review.verdict !== "accepted" ||
    !sameRef(review.candidateRef, candidate.ref) ||
    !sameRef(review.originalGoalContractRef, candidate.goalContractRef) ||
    !sameRef(review.reviewedBundleRef, candidate.bundle.ref) ||
    !sameRefs(review.reviewedWorkRefs, candidate.works.map((work) => work.ref)) ||
    !sameRefs(review.reviewedTaskRefs, candidate.tasks.map((task) => task.ref)) ||
    !sameRefs(review.reviewedCriterionRefs, candidate.criteria.map((criterion) => criterion.ref)) ||
    !sameRefs(
      review.reviewedVerificationQuestionRefs,
      candidate.verificationQuestions.map((question) => question.ref),
    ) ||
    !sameRefs(review.reviewedEffectIntentRefs, candidate.effectIntents.map((effect) => effect.ref)) ||
    !sameRefs(
      review.reviewedIntegrationCriterionRefs,
      candidate.integrationCriteria.map((criterion) => criterion.ref),
    ) ||
    !sameRef(review.reviewedArtifactLifecycleRef, candidate.artifactLifecycle.ref) ||
    !sameRefs(review.reviewedSpecRevisionRefs, candidate.authoredSpecRevisionRefs)
  ) {
    throw new Error("Work Ledger reviewed Plan receipt changed");
  }
}

function assertAcceptedFeedbackReview(
  current: ManagedProgramState,
  product: FeedbackPlanningAcceptedProduct,
): void {
  const { candidate, review } = product;
  if (
    review.verdict !== "accepted" ||
    !sameRef(review.candidateRef, candidate.ref) ||
    !sameRef(review.originalGoalContractRef, current.goalContractRef) ||
    review.correctionKind !== candidate.correctionKind ||
    review.findings.length !== 0
  ) {
    throw new Error("Work Ledger feedback Planning receipt changed");
  }
}

function assertDeferredContinuation(
  current: ManagedProgramState,
  mutation: BindProgram,
): void {
  const binding = mutation.product.authority.managedBinding;
  const continuation = binding.continuationBinding;
  if (
    binding.source !== "deferred_goal" ||
    continuation.kind !== "deferred_goal" ||
    current.programId !== binding.programId ||
    current.manifestRevision !== binding.expectedManifestRevision ||
    current.activeDeferral?.anchor.ref.id !== continuation.anchorRef.id
  ) {
    throw new Error("Work Ledger deferred Program binding changed");
  }
}

function resolveGoverningSpecRefs(
  logicalIds: string[],
  availableSpecs: AvailableSpecRevision[],
) {
  const byLogicalId = new Map(availableSpecs.map((spec) => [spec.logicalId, spec.revisionRef]));
  return logicalIds.map((logicalId) => {
    const revisionRef = byLogicalId.get(logicalId);
    if (!revisionRef) throw new Error(`Work Ledger governing Spec ${logicalId} changed`);
    return revisionRef;
  });
}

function selectGoverningSpecs(
  logicalIds: string[],
  revisions: GoverningSpecRevision[],
): GoverningSpecRevision[] {
  const byLogicalId = new Map(revisions.map((spec) => [spec.logicalId, spec]));
  return logicalIds.map((logicalId) => {
    const revision = byLogicalId.get(logicalId);
    if (!revision) throw new Error(`Work Ledger governing Spec body ${logicalId} changed`);
    return revision;
  });
}

function selectAcceptedGoverningSpecs(
  current: GoverningSpecRevision[],
  candidate: PlanningAcceptedProduct["candidate"],
): GoverningSpecRevision[] {
  const revisions = new Map(current.map((spec) => [refKey(spec.revisionRef), spec]));
  for (const spec of candidate.authoredSpecs) {
    revisions.set(refKey(spec.ref), {
      logicalId: spec.logicalId,
      parentId: spec.parentId,
      concernId: spec.concernId,
      title: spec.title,
      status: "specified",
      revisionRef: spec.ref,
      body: spec.body,
    });
  }
  return candidate.governingSpecRefs.map((ref) => {
    const revision = revisions.get(refKey(ref));
    if (!revision) throw new Error(`Work Ledger governing Spec body ${ref.id} changed`);
    return revision;
  });
}

function mergeAvailableSpecs(
  current: AvailableSpecRevision[],
  authored: ManagedSpecRevision[],
): AvailableSpecRevision[] {
  const byLogicalId = new Map(current.map((spec) => [spec.logicalId, spec]));
  for (const spec of authored) {
    byLogicalId.set(spec.logicalId, {
      logicalId: spec.logicalId,
      parentId: spec.parentId,
      concernId: spec.concernId,
      title: spec.title,
      status: "specified",
      revisionRef: spec.ref,
    });
  }
  return [...byLogicalId.values()]
    .sort((left, right) => left.logicalId.localeCompare(right.logicalId));
}

function sameRef(
  left: { id: string; sha256: string },
  right: { id: string; sha256: string },
): boolean {
  return refKey(left) === refKey(right);
}

function sameRefs(
  left: Array<{ id: string; sha256: string }>,
  right: Array<{ id: string; sha256: string }>,
): boolean {
  return left.length === right.length &&
    left.every((ref, index) => sameRef(ref, right[index]!));
}

function refKey(ref: { id: string; sha256: string }): string {
  return `${ref.id}\0${ref.sha256}`;
}
