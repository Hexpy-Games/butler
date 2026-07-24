import {
  contentRef,
  requireRecord,
  requireString,
  type ContentRef,
} from "../core/index.ts";
import type {
  CriterionVerdict,
  ReviewFinding,
  ReviewFindingCategory,
} from "./contracts.ts";

export function decodeReviewFindings(input: {
  submitted: unknown;
  criterionRefs: ContentRef[];
  taskRef: ContentRef;
  attemptRef: ContentRef;
  targetRevisionRefs: ContentRef[];
}): ReviewFinding[] {
  if (!Array.isArray(input.submitted)) {
    throw new Error("Task Review findings must be an array");
  }
  const findings = input.submitted.map((item, index) => {
    const submitted = requireRecord(item, `findings[${index}]`);
    const category = requireFindingCategory(submitted.findingCategory);
    const priority = requireFindingPriority(submitted.priority);
    const recommendedDisposition = submitted.recommendedDisposition === "backlog"
      ? "backlog" as const
      : "required_now" as const;
    const origin = requireFindingOrigin(submitted);
    const findingBody = {
      rootCauseKey: requireString(submitted.rootCauseKey, "finding root cause key"),
      affectedCriterionRefs: requireAffectedCriterionRefs(
        submitted.affectedCriterionRefs,
        input.criterionRefs,
      ),
      taskRef: input.taskRef,
      attemptRef: input.attemptRef,
      category,
      statement: requireString(submitted.finding, "finding statement"),
      priority,
      recommendedDisposition,
      origin,
      targetRevisionRefs: input.targetRevisionRefs,
    };
    return {
      ref: contentRef("finding", findingBody),
      ...findingBody,
    };
  });
  if (new Set(findings.map((finding) => finding.rootCauseKey)).size !== findings.length) {
    throw new Error("Task Review root cause keys must be unique");
  }
  return findings;
}

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
): ReviewFinding["origin"] {
  if (submitted.findingOrigin === "initial_review") {
    return { kind: "initial_review" };
  }
  if (submitted.findingOrigin === "backlog_candidate") {
    return { kind: "backlog_candidate" };
  }
  throw new Error("Task Review finding origin is invalid");
}

export function validateCorrectionFindingScope(
  findings: ReviewFinding[],
  priorFindings: ReviewFinding[],
): void {
  if (priorFindings.length === 0) return;
  const blocking = findings
    .filter((finding) => finding.recommendedDisposition === "required_now");
  const priorIds = new Set(priorFindings.map((finding) => finding.ref.id));
  const causalIds = blocking.map((finding) =>
    priorIds.has(finding.ref.id) ? finding.ref.id : "");
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
  _verdicts: CriterionVerdict[],
): ReviewFinding[] {
  const unique = [...new Map(findings.map((finding) => [finding.ref.id, finding])).values()];
  const rootCauseRefs = new Map<string, string>();
  for (const finding of unique) {
    const priorRef = rootCauseRefs.get(finding.rootCauseKey);
    if (priorRef && priorRef !== finding.ref.id) {
      throw new Error("Task Review redefined one root cause");
    }
    rootCauseRefs.set(finding.rootCauseKey, finding.ref.id);
  }
  const priority = { P0: 0, P1: 1, P2: 2 };
  return unique.sort(
    (left, right) => priority[left.priority] - priority[right.priority],
  );
}

export function requireAffectedCriterionRefs(
  value: unknown,
  allowedCriterionRefs: ContentRef[],
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
  if (refs.some((ref) =>
    !allowedCriterionRefs.some((allowed) => sameRef(ref, allowed)))) {
    throw new Error("Task Review finding names a criterion outside the current Task");
  }
  return refs;
}

function refKey(ref: { id: string; sha256: string }): string {
  return `${ref.id}\0${ref.sha256}`;
}

function sameRef(left: ContentRef, right: ContentRef): boolean {
  return left.id === right.id && left.sha256 === right.sha256;
}
