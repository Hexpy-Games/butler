import { contentRef, type ContentRef } from "../../core/index.ts";
import type { PlanningCandidate, PlanningContinuation } from "../contracts.ts";
import { rejectPlanningProposal } from "./planning-proposal-defect.ts";

type ResumeState = {
  ledgerId: string;
  programId: string;
  observedManifestRevision: number;
  goalContractRef: ContentRef;
  authorityRef: ContentRef;
  continuation?: PlanningContinuation;
};

export function resumeStoppedAcceptedPlan(
  submission: Record<string, unknown>,
  state: ResumeState,
): PlanningCandidate | null {
  const continuation = state.continuation;
  const interrupted = continuation?.kind === "stopped_program"
    ? continuation.context?.frontier.interruptedTask
    : undefined;
  if (!interrupted?.resultRef) return null;
  if (submission.kind !== "stopped_plan_resume") {
    rejectPlanningProposal(
      "stopped_result_plan_must_resume",
      "Planning must use the stopped Plan resume contract when the interrupted Task already has a ResultCandidate",
    );
  }
  const prior = continuation?.context?.acceptedPlan;
  if (!prior || continuation?.kind !== "stopped_program") {
    rejectPlanningProposal(
      "stopped_result_plan_missing",
      "Planning cannot resume without the immutable accepted Plan",
    );
  }
  if (!matchesPriorPlan(prior, interrupted.task.ref, state)) {
    rejectPlanningProposal(
      "stopped_result_plan_identity_mismatch",
      "The immutable accepted Plan does not contain the exact stopped Task",
    );
  }
  const revisionOrigin = {
    kind: "stopped_continuation" as const,
    continuationBindingRef: continuation.ref,
    sourceTurnId: continuation.sourceTurnId,
    stoppedAnchorRef: continuation.anchorRef,
    stoppedTaskRef: interrupted.task.ref,
    stoppedResultRef: interrupted.resultRef,
    stoppedPlanGoalContractRef: prior.goalContractRef,
  };
  const bundleBody = {
    ledgerId: state.ledgerId,
    programId: state.programId,
    observedManifestRevision: state.observedManifestRevision,
    recordRefs: prior.bundle.recordRefs,
  };
  const bundle = { ref: contentRef("planning-candidate-bundle", bundleBody), ...bundleBody };
  const { ref: _priorRef, bundle: _priorBundle, ...priorBody } = prior;
  const candidateBody = {
    ...priorBody,
    observedManifestRevision: state.observedManifestRevision,
    goalContractRef: state.goalContractRef,
    authorityRef: state.authorityRef,
    revisionOrigin,
    resolvedDeferralAnchorRefs: [],
    bundle,
  };
  return { ref: contentRef("plan-candidate", candidateBody), ...candidateBody };
}

function matchesPriorPlan(
  prior: PlanningCandidate,
  taskRef: ContentRef,
  state: ResumeState,
): boolean {
  const { ref: priorRef, ...priorBody } = prior;
  const canonicalRef = contentRef("plan-candidate", priorBody);
  return prior.ledgerId === state.ledgerId &&
    prior.programId === state.programId &&
    sameRef(priorRef, canonicalRef) &&
    prior.tasks.some((task) =>
      task.ref.id === taskRef.id && task.ref.sha256 === taskRef.sha256);
}

function sameRef(left: ContentRef, right: ContentRef): boolean {
  return left.id === right.id && left.sha256 === right.sha256;
}
