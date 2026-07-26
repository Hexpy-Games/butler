import type {
  PlanningCandidate,
  PlanningFindingDecision,
  PlanningProposal,
  PlanningReview,
} from "./contracts.ts";
import { planningReviewSubjects } from "./review-subjects.ts";

export function assertRevisedPlanChanged(input: {
  previous: PlanningProposal;
  revised: PlanningProposal;
  priorReview: PlanningReview;
  decisions: PlanningFindingDecision[];
}): void {
  if ("validationFindings" in input.revised) {
    throw new Error("Planning revision must materialize before re-review");
  }
  const applied = input.decisions.filter((decision) => decision.decision === "apply_now");
  if (applied.length === 0 || "validationFindings" in input.previous) return;

  const priorFindings = input.priorReview.findingSet?.findings ?? [];
  const priorByRef = new Map(priorFindings.map((finding) => [finding.ref.id, finding]));
  const previousSubjects = subjectRefs(input.previous);
  const revisedSubjects = subjectRefs(input.revised);

  for (const decision of applied) {
    const finding = priorByRef.get(decision.findingRef.id);
    if (!finding) throw new Error("Planning revision decision changed its frozen finding");
    const changed = finding.affectedSubjectIds.some((subjectId) =>
      !sameRef(previousSubjects.get(subjectId), revisedSubjects.get(subjectId)),
    );
    if (!changed) {
      throw new Error(
        `Planning revision did not change an affected subject: ${finding.rootCauseKey}`,
      );
    }
  }
}

function subjectRefs(candidate: PlanningCandidate): Map<string, { id: string; sha256: string }> {
  return new Map(planningReviewSubjects(candidate).map((subject) => [
    subject.subjectId,
    subject.subjectRef,
  ]));
}

function sameRef(
  left: { id: string; sha256: string } | undefined,
  right: { id: string; sha256: string } | undefined,
): boolean {
  return Boolean(left && right && left.id === right.id && left.sha256 === right.sha256);
}
