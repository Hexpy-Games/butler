import {
  requireRecord,
  requireString,
  type ContentRef,
} from "../core/index.ts";
import type {
  CriterionVerdict,
  ReviewFinding,
  ReviewFindingCategory,
} from "./contracts.ts";

export function requireFindingPriority(value: unknown): "P0" | "P1" | "P2" {
  if (value !== "P0" && value !== "P1" && value !== "P2") {
    throw new Error("Task Review finding priority is invalid");
  }
  return value;
}

export function requireFindingCategory(value: unknown): ReviewFindingCategory {
  const allowed: ReviewFindingCategory[] = [
    "implementation_nonconformance", "authority_contradiction", "goal_drift",
    "task_decomposition", "dependency_invalid", "verification_incomplete",
    "missing_observation",
  ];
  if (typeof value !== "string" || !allowed.includes(value as ReviewFindingCategory)) {
    throw new Error("Task Review finding category is invalid");
  }
  return value as ReviewFindingCategory;
}

export function requireFindingOrigin(
  submitted: Record<string, unknown>,
  priorFindings: ReviewFinding[],
): ReviewFinding["origin"] {
  if (submitted.findingOrigin === "initial_review" && priorFindings.length === 0) {
    return { kind: "initial_review" };
  }
  if (submitted.findingOrigin === "backlog_candidate") {
    return { kind: "backlog_candidate" };
  }
  if (submitted.findingOrigin === "prior_finding") {
    const prior = priorFindings.find((finding) => finding.ref.id === submitted.priorFindingId);
    if (
      prior &&
      prior.statement === submitted.finding &&
      prior.category === submitted.findingCategory &&
      prior.priority === submitted.priority
    ) {
      return { kind: "prior_finding", findingRef: prior.ref };
    }
    throw new Error("Task re-review changed its frozen finding");
  }
  if (submitted.findingOrigin === "correction_regression" && priorFindings.length > 0) {
    const prior = priorFindings.find((finding) => finding.ref.id === submitted.priorFindingId);
    if (prior) return { kind: "correction_regression", findingRef: prior.ref };
  }
  throw new Error("Task Review finding origin is outside the correction scope");
}

export function validateCorrectionFindingScope(
  findings: ReviewFinding[],
  priorFindings: ReviewFinding[],
): void {
  if (priorFindings.length === 0) return;
  const blocking = findings
    .filter((finding) => finding.recommendedDisposition === "required_now");
  const priorIds = new Set(priorFindings.map((finding) => finding.ref.id));
  const causalIds = blocking.map((finding) => {
    if (priorIds.has(finding.ref.id)) return finding.ref.id;
    return finding.origin.kind === "prior_finding" ||
      finding.origin.kind === "correction_regression"
      ? finding.origin.findingRef.id
      : "";
  });
  if (
    causalIds.some((id) => id.length === 0) ||
    new Set(causalIds).size !== causalIds.length ||
    blocking.length > priorFindings.length
  ) {
    throw new Error("Task re-review expanded its frozen correction scope");
  }
}

export function requirePriorFindings(value: unknown): ReviewFinding[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("priorCorrectionFindings must be an array");
  return value.filter((finding): finding is ReviewFinding =>
    Boolean(finding && typeof finding === "object" &&
      (finding as ReviewFinding).recommendedDisposition === "required_now"));
}

export function normalizeRootFindings(
  findings: ReviewFinding[],
  verdicts: CriterionVerdict[],
): ReviewFinding[] {
  const unique = [...new Map(findings.map((finding) => [finding.ref.id, finding])).values()];
  const rootCauseRefs = new Map<string, string>();
  for (const finding of unique) {
    const priorRef = rootCauseRefs.get(finding.rootCauseKey);
    if (priorRef && priorRef !== finding.ref.id) {
      throw new Error("Task Review redefined one root cause");
    }
    rootCauseRefs.set(finding.rootCauseKey, finding.ref.id);
    const attached = verdicts
      .filter((verdict) => verdict.findingRefs.some((ref) => ref.id === finding.ref.id))
      .map((verdict) => verdict.criterionRef)
      .sort((left, right) => refKey(left).localeCompare(refKey(right)));
    if (!sameRefs(attached, finding.affectedCriterionRefs)) {
      throw new Error("Task Review root finding attachments are incomplete");
    }
  }
  const priority = { P0: 0, P1: 1, P2: 2 };
  return unique.sort(
    (left, right) => priority[left.priority] - priority[right.priority],
  );
}

export function requireAffectedCriterionRefs(
  value: unknown,
  currentCriterionRef: ContentRef,
): ContentRef[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("Task Review finding must name affected criteria");
  }
  const refs = [...new Map(value.map((item, index) => {
    const record = requireRecord(item, `affectedCriterionRefs[${index}]`);
    const ref = {
      id: requireString(record.id, `affectedCriterionRefs[${index}].id`),
      sha256: requireString(record.sha256, `affectedCriterionRefs[${index}].sha256`),
    };
    return [refKey(ref), ref];
  })).values()].sort((left, right) => refKey(left).localeCompare(refKey(right)));
  if (!refs.some((ref) => sameRef(ref, currentCriterionRef))) {
    throw new Error("Task Review finding is not attached to its current criterion");
  }
  return refs;
}

export function sameRefList(left: ContentRef[], right: ContentRef[]): boolean {
  return left.length === right.length &&
    left.every((ref, index) => sameRef(ref, right[index]!));
}

function refKey(ref: { id: string; sha256: string }): string {
  return `${ref.id}\0${ref.sha256}`;
}

function sameRefs(
  left: Array<{ id: string; sha256: string }>,
  right: Array<{ id: string; sha256: string }>,
): boolean {
  return left.length === right.length &&
    left.every((ref, index) =>
      ref.id === right[index]?.id && ref.sha256 === right[index]?.sha256);
}

function sameRef(left: ContentRef, right: ContentRef): boolean {
  return left.id === right.id && left.sha256 === right.sha256;
}
