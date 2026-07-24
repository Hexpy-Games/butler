import {
  contentRef,
  requireRecord,
  requireString,
  type ContentRef,
} from "../core/index.ts";
import type {
  PlanningDraftCandidate,
  PlanningFindingSet,
  PlanningReview,
  PlanningReviewDimension,
  PlanningReviewSubjectFinding,
} from "./contracts.ts";
import { PLANNING_REVIEW_DIMENSIONS } from "./review-subjects.ts";

const PRIORITY_ORDER = { P0: 0, P1: 1, P2: 2 } as const;

export function createPlanningFindingSet(
  candidateRef: ContentRef,
  findings: PlanningReviewSubjectFinding[],
): PlanningFindingSet {
  const ordered = [...findings].sort(
    (left, right) => PRIORITY_ORDER[left.priority] - PRIORITY_ORDER[right.priority],
  );
  if (new Set(ordered.map((finding) => finding.ref.id)).size !== ordered.length) {
    throw new Error("Planning FindingSet contains duplicate finding identities");
  }
  const body = {
    candidateRef,
    findingRefs: ordered.map((finding) => finding.ref),
  };
  return {
    ref: contentRef("planning-finding-set", body),
    candidateRef,
    findings: ordered,
  };
}

export function requiredPlanningFindings(
  review: PlanningReview | undefined,
): PlanningReviewSubjectFinding[] {
  if (!review) return [];
  if (!review.findingSet) {
    throw new Error("Planning revision review has no structured FindingSet");
  }
  if (
    !sameRef(review.findingSet.candidateRef, review.candidateRef) ||
    !review.findingSetRef ||
    !sameRef(review.findingSet.ref, review.findingSetRef)
  ) {
    throw new Error("Planning revision review changed its FindingSet identity");
  }
  if (
    new Set(review.findingSet.findings.map((finding) => finding.ref.id)).size !==
      review.findingSet.findings.length
  ) {
    throw new Error("Planning revision review has duplicate finding identities");
  }
  return review.findingSet.findings.filter(
    (finding) => finding.recommendedDisposition === "required_now",
  );
}

function sameRef(left: ContentRef, right: ContentRef): boolean {
  return left.id === right.id && left.sha256 === right.sha256;
}

export function draftReviewFindings(
  candidate: PlanningDraftCandidate,
  value: unknown,
): PlanningReviewSubjectFinding[] {
  const structural = candidate.validationFindings.map((finding) => {
    const body = {
      dimension: "task_executability" as const,
      message: `${finding.code}: ${finding.message}`,
      priority: "P0" as const,
      recommendedDisposition: "required_now" as const,
      origin: { kind: "initial_review" as const },
    };
    return {
      ref: contentRef("planning-review-finding", {
        subjectId: `draft:${candidate.ref.id}`,
        ...body,
      }),
      ...body,
    };
  });
  if (!Array.isArray(value)) {
    throw new Error("Planning draft Review findings must be an array");
  }
  return [
    ...structural,
    ...value.map((item, index) => decodeDraftFinding(candidate, item, index)),
  ];
}

function decodeDraftFinding(
  candidate: PlanningDraftCandidate,
  value: unknown,
  index: number,
): PlanningReviewSubjectFinding {
  const finding = requireRecord(value, `Planning draft Review finding[${index}]`);
  const dimension = finding.dimension as PlanningReviewDimension;
  if (!PLANNING_REVIEW_DIMENSIONS.includes(dimension)) {
    throw new Error("Planning draft Review finding dimension is invalid");
  }
  if (finding.priority !== "P0" && finding.priority !== "P1" && finding.priority !== "P2") {
    throw new Error("Planning draft Review finding priority is invalid");
  }
  if (
    finding.recommendedDisposition !== "required_now" &&
    finding.recommendedDisposition !== "backlog"
  ) {
    throw new Error("Planning draft Review finding disposition is invalid");
  }
  const required = finding.recommendedDisposition === "required_now";
  const priority = finding.priority as "P0" | "P1" | "P2";
  const recommendedDisposition = finding.recommendedDisposition as
    | "required_now"
    | "backlog";
  if (
    (required && finding.findingOrigin !== "initial_review") ||
    (!required && finding.findingOrigin !== "backlog_candidate")
  ) {
    throw new Error("Planning draft Review finding origin is invalid");
  }
  const body = {
    dimension,
    message: requireString(finding.message, "Planning draft Review finding message"),
    priority,
    recommendedDisposition,
    origin: required
      ? { kind: "initial_review" as const }
      : { kind: "backlog_candidate" as const },
  };
  return {
    ref: contentRef("planning-review-finding", {
      subjectId: `draft:${candidate.ref.id}`,
      ...body,
    }),
    ...body,
  };
}
