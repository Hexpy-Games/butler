import {
  requireRecord,
  requireString,
  type ContentRef,
} from "../core/index.ts";
import type { PlanningFindingDecision } from "./contracts.ts";

export function decodeFindingDecisions(
  value: unknown,
  expected: ContentRef[],
  label = "Planning",
): PlanningFindingDecision[] {
  if (expected.length === 0) return [];
  if (!Array.isArray(value) || value.length !== expected.length) {
    throw new Error(`${label} must decide every required finding`);
  }
  const byId = new Map(expected.map((ref) => [ref.id, ref]));
  const seen = new Set<string>();
  return value.map((item, index) => {
    const decision = requireRecord(item, `${label} findingDecisions[${index}]`);
    const findingId = requireString(decision.findingId, `${label} finding id`);
    const findingRef = byId.get(findingId);
    if (!findingRef || seen.has(findingId)) {
      throw new Error(`${label} finding decisions must be exact, unique, and complete`);
    }
    seen.add(findingId);
    if (
      decision.decision !== "apply_now" &&
      decision.decision !== "dispute" &&
      decision.decision !== "split_to_backlog"
    ) {
      throw new Error(`${label} finding decision is invalid`);
    }
    return {
      findingRef,
      decision: decision.decision,
      rationale: requireString(decision.rationale, `${label} finding decision rationale`),
    };
  });
}

export function requiredSubjectFindingRefs(value: unknown): ContentRef[] {
  if (value === undefined) return [];
  const review = requireRecord(value, "priorPlanningReview");
  if (!Array.isArray(review.reviewedSubjects)) {
    throw new Error("priorPlanningReview has no reviewed subjects");
  }
  return review.reviewedSubjects.flatMap((item, subjectIndex) => {
    const subject = requireRecord(item, `priorPlanningReview subject[${subjectIndex}]`);
    return requiredFindingRefs(subject.findings, `priorPlanningReview subject[${subjectIndex}]`);
  });
}

export function requiredFeedbackFindingRefs(value: unknown): ContentRef[] {
  if (value === undefined) return [];
  const review = requireRecord(value, "previousFeedbackPlanningReview");
  return requiredFindingRefs(
    review.reviewedFindings,
    "previousFeedbackPlanningReview",
  );
}

function requiredFindingRefs(value: unknown, label: string): ContentRef[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item, index) => {
    const finding = requireRecord(item, `${label} finding[${index}]`);
    return finding.recommendedDisposition === "required_now"
      ? [requireContentRef(finding.ref, `${label} finding[${index}].ref`)]
      : [];
  });
}

function requireContentRef(value: unknown, label: string): ContentRef {
  const ref = requireRecord(value, label);
  return {
    id: requireString(ref.id, `${label}.id`),
    sha256: requireString(ref.sha256, `${label}.sha256`),
  };
}
