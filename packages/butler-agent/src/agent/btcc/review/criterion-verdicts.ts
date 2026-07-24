import {
  contentRef,
  requireRecord,
  requireString,
  stableJson,
  type ContentRef,
} from "../core/index.ts";
import type { ResultCandidateProduct } from "../execution/index.ts";
import type {
  CriterionVerdict,
  ReviewFinding,
  ReviewFindingVerdict,
  ReviewObservation,
} from "./contracts.ts";
import { decodeReviewFindings } from "./review-findings.ts";

export function decodeCriterionVerdicts(input: {
  submitted: unknown;
  submittedFindings: unknown;
  submittedPriorFindingVerdicts: unknown;
  criteria: Record<string, unknown>[];
  questions: Record<string, unknown>[];
  result: ResultCandidateProduct;
  checkpointId: string;
  runtimeBoundResultRefs: ContentRef[];
  priorFindings: ReviewFinding[];
}): {
  verdicts: CriterionVerdict[];
  observations: ReviewObservation[];
  findings: ReviewFinding[];
  findingVerdicts: ReviewFindingVerdict[];
} {
  if (!Array.isArray(input.submitted) || input.submitted.length !== input.criteria.length) {
    throw new Error(
      "Task Review must submit exactly one verdict for each stateInput.criteria entry",
    );
  }
  const criteria = new Map(input.criteria.map((criterion) => {
    const ref = requireContentRef(criterion.ref, "criterion.ref");
    return [refKey(ref), { criterion, ref }];
  }));
  const reviewedCriteria = new Set<string>();
  const observations: ReviewObservation[] = [];
  const targetRevisionRefs = input.result.result.targetStateRevisions.map((item) => item.ref);
  const submittedFindings = decodeReviewFindings({
    submitted: input.submittedFindings,
    criterionRefs: [...criteria.values()].map((item) => item.ref),
    taskRef: input.result.result.taskRef,
    attemptRef: input.result.result.attemptRef,
    targetRevisionRefs,
  });
  const findingVerdicts = decodePriorFindingVerdicts(
    input.submittedPriorFindingVerdicts,
    input.priorFindings,
  );
  const findings = [
    ...findingVerdicts
      .filter((verdict) => verdict.verdict !== "resolved")
      .map((verdict) => input.priorFindings.find((finding) =>
        finding.ref.id === verdict.findingRef.id)!),
    ...submittedFindings,
  ];
  const verdicts = input.submitted.map((item, index) => {
    const submitted = requireRecord(item, `criterionVerdicts[${index}]`);
    const criterionRef = requireContentRef(
      submitted.criterionRef,
      `criterionVerdicts[${index}].criterionRef`,
    );
    const criterionKey = refKey(criterionRef);
    if (!criteria.has(criterionKey)) {
      throw new Error("Task Review submitted a criterion outside stateInput.criteria");
    }
    if (reviewedCriteria.has(criterionKey)) {
      throw new Error("Task Review repeated a current Task criterion");
    }
    reviewedCriteria.add(criterionKey);
    const questionRefs = input.questions
      .filter((question) => stableJson(question.criterionRef) === stableJson(criterionRef))
      .map((question) => requireContentRef(question.ref, "question.ref"));
    if (submitted.verdict !== "satisfied" && submitted.verdict !== "not_satisfied") {
      throw new Error("Task Review criterion verdict is invalid");
    }
    const criterionVerdict = submitted.verdict as "satisfied" | "not_satisfied";
    const criterionFindings = findings.filter((finding) =>
      finding.affectedCriterionRefs.some((ref) => sameContentRef(ref, criterionRef)));
    const hasBlockingFinding = criterionFindings.some(
      (finding) => finding.recommendedDisposition === "required_now",
    );
    if ((criterionVerdict === "not_satisfied") !== hasBlockingFinding) {
      throw new Error("Task Review criterion verdict conflicts with required-now findings");
    }
    const observationBody = {
      taskRef: input.result.result.taskRef,
      attemptRef: input.result.result.attemptRef,
      executionTargetRef: input.result.result.executionTargetRef,
      targetRevisionRefs,
      description: requireString(submitted.observation, "criterion observation"),
      reviewedResultRefs: input.runtimeBoundResultRefs,
      reviewCheckpointRef: input.checkpointId,
    };
    const observation = {
      ref: contentRef("review-observation", observationBody), ...observationBody,
    };
    observations.push(observation);
    return {
      criterionRef,
      verificationQuestionRefs: questionRefs,
      currentTargetRevisionRefs: targetRevisionRefs,
      reviewedResultRefs: input.runtimeBoundResultRefs,
      observationRefs: [observation.ref],
      verdict: criterionVerdict,
      findingRefs: criterionFindings.map((finding) => finding.ref),
    };
  });
  if (reviewedCriteria.size !== criteria.size) {
    throw new Error("Task Review did not cover every accepted criterion");
  }
  return { verdicts, observations, findings, findingVerdicts };
}

function decodePriorFindingVerdicts(
  value: unknown,
  priorFindings: ReviewFinding[],
): ReviewFindingVerdict[] {
  if (priorFindings.length === 0) return [];
  if (!Array.isArray(value) || value.length !== priorFindings.length) {
    throw new Error("Task re-review must judge every frozen finding");
  }
  const byRootCause = new Map(priorFindings.map((finding) => [
    finding.rootCauseKey,
    finding,
  ]));
  const seen = new Set<string>();
  return value.map((item, index) => {
    const submitted = requireRecord(item, `priorFindingVerdicts[${index}]`);
    const rootCauseKey = requireString(
      submitted.rootCauseKey,
      "Task re-review root cause key",
    );
    const finding = byRootCause.get(rootCauseKey);
    if (!finding || seen.has(rootCauseKey)) {
      throw new Error("Task re-review finding verdicts must be exact and unique");
    }
    seen.add(rootCauseKey);
    if (
      submitted.verdict !== "resolved" &&
      submitted.verdict !== "unresolved" &&
      submitted.verdict !== "regressed"
    ) {
      throw new Error("Task re-review finding verdict is invalid");
    }
    return {
      findingRef: finding.ref,
      verdict: submitted.verdict,
      observation: requireString(submitted.observation, "Task re-review observation"),
    };
  });
}

export function requireRecords(value: unknown, label: string): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} is empty`);
  return value.map((item, index) => requireRecord(item, `${label}[${index}]`));
}

export function requireContentRef(value: unknown, label: string): ContentRef {
  const record = requireRecord(value, label);
  return {
    id: requireString(record.id, `${label}.id`),
    sha256: requireString(record.sha256, `${label}.sha256`),
  };
}

function refKey(ref: ContentRef): string {
  return `${ref.id}\0${ref.sha256}`;
}

export function uniqueRefs(refs: ContentRef[]): ContentRef[] {
  return [...new Map(refs.map((ref) => [refKey(ref), ref])).values()];
}

export function sameContentRef(left: ContentRef, right: ContentRef): boolean {
  return left.id === right.id && left.sha256 === right.sha256;
}
