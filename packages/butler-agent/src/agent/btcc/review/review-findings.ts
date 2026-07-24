import type {
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
  const causalIds = blocking.map((finding) =>
    finding.origin.kind === "prior_finding" ||
    finding.origin.kind === "correction_regression"
      ? finding.origin.findingRef.id
      : "");
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

export function orderFindings(findings: ReviewFinding[]): ReviewFinding[] {
  const priority = { P0: 0, P1: 1, P2: 2 };
  return [...findings].sort(
    (left, right) => priority[left.priority] - priority[right.priority],
  );
}
