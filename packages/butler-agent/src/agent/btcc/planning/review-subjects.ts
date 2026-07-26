import {
  contentRef,
  requireRecord,
  requireString,
  type ContentRef,
} from "../core/index.ts";
import type {
  PlanningCandidate,
  PlanningReviewCoverage,
  PlanningReviewDimension,
  PlanningReviewFindingVerdict,
  PlanningReviewSubject,
  PlanningReviewSubjectCoverage,
  PlanningReviewSubjectFinding,
  PlanningReviewSubjectKind,
} from "./contracts.ts";

export const PLANNING_REVIEW_DIMENSIONS: readonly PlanningReviewDimension[] = [
  "original_goal",
  "governing_specs",
  "work_cohesion",
  "task_executability",
  "dependencies",
  "verification_integration",
  "effect_authority",
  "artifact_lifecycle",
];

export function planningReviewSubjects(
  candidate: PlanningCandidate,
): PlanningReviewSubject[] {
  const subjects = [
    subject("goal:original", "original_goal", candidate.goalContractRef),
    ...candidate.governingSpecRefs.map((ref) =>
      subject(`spec:${ref.id}`, "governing_spec", ref)),
    subject("plan:strategy", "plan", candidate.plan.ref),
    subject("graph:work", "work_graph", candidate.workGraph.ref),
    ...candidate.works.map((item) =>
      subject(`work:${item.workLogicalId}`, "work", item.ref)),
    ...candidate.tasks.map((item) =>
      subject(`task:${item.taskLogicalId}`, "task", item.ref)),
    ...candidate.criteria.map((item) =>
      subject(`criterion:${item.taskLogicalId}:${item.ordinal}`, "criterion", item.ref)),
    ...candidate.verificationQuestions.map((item) =>
      subject(`question:${item.ref.id}`, "verification_question", item.ref)),
    ...candidate.risks.map((item) =>
      subject(`risk:${item.logicalId}`, "risk", item.ref)),
    ...candidate.assumptions.map((item) =>
      subject(`assumption:${item.logicalId}`, "assumption", item.ref)),
    ...candidate.integrationCriteria.map((item) =>
      subject(`integration:${item.logicalId}`, "integration_criterion", item.ref)),
    ...candidate.effectIntents.map((item) =>
      subject(`effect:${item.occurrenceKey}`, "effect_intent", item.ref)),
    subject("lifecycle:artifact", "artifact_lifecycle", candidate.artifactLifecycle.ref),
  ];
  if (new Set(subjects.map((item) => item.subjectId)).size !== subjects.length) {
    throw new Error("Planning Review candidate subject ids must be unique");
  }
  return subjects;
}

export function requireSubjectCoverage(
  value: unknown,
  expected: PlanningReviewSubject[],
  findings: PlanningReviewSubjectFinding[],
): PlanningReviewSubjectCoverage[] {
  if (!Array.isArray(value) || value.length !== expected.length) {
    throw new Error("Planning Review must judge every candidate subject");
  }
  const expectedById = new Map(expected.map((item) => [item.subjectId, item]));
  const seen = new Set<string>();
  const coverage = value.map((item, index) => {
    const entry = requireRecord(item, `Planning Review subjects[${index}]`);
    const subjectId = requireString(entry.subjectId, "Planning Review subject id");
    const expectedSubject = expectedById.get(subjectId);
    if (!expectedSubject || seen.has(subjectId)) {
      throw new Error("Planning Review subjects must be exact, unique, and complete");
    }
    seen.add(subjectId);
    if (entry.verdict !== "passed" && entry.verdict !== "failed") {
      throw new Error("Planning Review subject verdict is invalid");
    }
    const subjectFindings = findings.filter((finding) =>
      finding.affectedSubjectIds.includes(subjectId));
    const hasBlockingFinding = subjectFindings.some(
      (finding) => finding.recommendedDisposition === "required_now",
    );
    if ((entry.verdict === "failed") !== hasBlockingFinding) {
      throw new Error("Planning Review subject verdict conflicts with required-now findings");
    }
    return {
      ...expectedSubject,
      verdict: entry.verdict,
      findings: subjectFindings,
    } satisfies PlanningReviewSubjectCoverage;
  });
  if (seen.size !== expected.length) {
    throw new Error("Planning Review subjects must be exact, unique, and complete");
  }
  return coverage;
}

export function projectSubjectCoverage(
  expected: PlanningReviewSubject[],
  findings: PlanningReviewSubjectFinding[],
): PlanningReviewSubjectCoverage[] {
  return expected.map((subject) => {
    const subjectFindings = findings.filter((finding) =>
      finding.affectedSubjectIds.includes(subject.subjectId));
    return {
      ...subject,
      verdict: subjectFindings.some((finding) =>
          finding.recommendedDisposition === "required_now")
        ? "failed" as const
        : "passed" as const,
      findings: subjectFindings,
    };
  });
}

export function resolvePlanningReviewFindings(
  findingValue: unknown,
  priorVerdictValue: unknown,
  expected: PlanningReviewSubject[],
  priorFindings: PlanningReviewSubjectFinding[],
): {
  findings: PlanningReviewSubjectFinding[];
  verdicts: PlanningReviewFindingVerdict[];
} {
  const expectedSubjectIds = expected.map((subject) => subject.subjectId);
  const submitted = requireRootFindings(findingValue, expectedSubjectIds);
  if (priorFindings.length === 0) {
    return { findings: submitted, verdicts: [] };
  }
  if (submitted.length > 0) {
    throw new Error("Planning re-review cannot submit a new finding");
  }
  const verdicts = requirePriorFindingVerdicts(priorVerdictValue, priorFindings);
  const unresolved = verdicts
    .filter((verdict) => verdict.verdict === "unresolved")
    .map((verdict) => priorFindings.find((finding) =>
      finding.ref.id === verdict.findingRef.id)!);
  return { findings: unresolved, verdicts };
}

export function requireDimensionCoverage(
  value: unknown,
  subjects: PlanningReviewSubjectCoverage[],
): PlanningReviewCoverage[] {
  if (!Array.isArray(value) || value.length !== PLANNING_REVIEW_DIMENSIONS.length) {
    throw new Error("Planning Review must cover every review dimension");
  }
  const projected = projectDimensionCoverage(subjects);
  const projectedByDimension = new Map(projected.map((item) => [item.dimension, item]));
  const seen = new Set<PlanningReviewDimension>();
  const coverage = value.map((item, index) => {
    const entry = requireRecord(item, `Planning Review coverage[${index}]`);
    const dimension = entry.dimension as PlanningReviewDimension;
    if (!PLANNING_REVIEW_DIMENSIONS.includes(dimension) || seen.has(dimension)) {
      throw new Error("Planning Review coverage dimensions must be unique and complete");
    }
    seen.add(dimension);
    const expectedCoverage = projectedByDimension.get(dimension)!;
    if (entry.verdict !== expectedCoverage.verdict) {
      throw new Error("Planning Review dimension verdict conflicts with subject findings");
    }
    return expectedCoverage;
  });
  if (seen.size !== PLANNING_REVIEW_DIMENSIONS.length) {
    throw new Error("Planning Review coverage dimensions must be unique and complete");
  }
  return coverage;
}

export function projectDimensionCoverage(
  subjects: PlanningReviewSubjectCoverage[],
): PlanningReviewCoverage[] {
  return PLANNING_REVIEW_DIMENSIONS.map((dimension) => {
    const findings = [...new Set(subjects.flatMap((subject) => subject.findings)
      .filter((finding) =>
        finding.dimension === dimension &&
        finding.recommendedDisposition === "required_now")
      .map((finding) => finding.message))];
    return {
      dimension,
      verdict: findings.length > 0 ? "failed" as const : "passed" as const,
      findings,
    };
  });
}

function subject(
  subjectId: string,
  kind: PlanningReviewSubjectKind,
  ref: ContentRef,
): PlanningReviewSubject {
  return { subjectId, kind, subjectRef: ref };
}

function requireRootFindings(
  value: unknown,
  expectedSubjectIds: string[],
): PlanningReviewSubjectFinding[] {
  if (!Array.isArray(value)) {
    throw new Error("Planning Review findings must be an array");
  }
  const findings = value.map((item, index) => {
    const finding = requireRecord(
      item,
      `Planning Review finding[${index}]`,
    );
    if (!PLANNING_REVIEW_DIMENSIONS.includes(finding.dimension as PlanningReviewDimension)) {
      throw new Error("Planning Review subject finding dimension is invalid");
    }
    if (finding.priority !== "P0" && finding.priority !== "P1" && finding.priority !== "P2") {
      throw new Error("Planning Review subject finding priority is invalid");
    }
    if (
      finding.recommendedDisposition !== "required_now" &&
      finding.recommendedDisposition !== "backlog"
    ) {
      throw new Error("Planning Review subject finding disposition is invalid");
    }
    const priority = finding.priority as "P0" | "P1" | "P2";
    const recommendedDisposition = finding.recommendedDisposition as
      | "required_now"
      | "backlog";
    const scopeRelation = requirePlanningScope(finding.scopeRelation);
    const body = {
      rootCauseKey: requireString(
        finding.rootCauseKey,
        "Planning Review finding root cause key",
      ),
      affectedSubjectIds: requireAffectedSubjectIds(
        finding.affectedSubjectIds,
        expectedSubjectIds,
      ),
      dimension: finding.dimension as PlanningReviewDimension,
      message: requireString(finding.message, "Planning Review finding message"),
      priority,
      scopeRelation,
      recommendedDisposition,
      dispositionRationale: requireString(
        finding.dispositionRationale,
        "Planning Review finding disposition rationale",
      ),
    };
    if (recommendedDisposition === "required_now" && finding.findingOrigin !== "initial_review") {
      throw new Error("Initial Planning finding origin is invalid");
    }
    if (recommendedDisposition === "backlog" && finding.findingOrigin !== "backlog_candidate") {
      throw new Error("Planning backlog finding origin is invalid");
    }
    const origin = recommendedDisposition === "required_now"
      ? { kind: "initial_review" as const }
      : { kind: "backlog_candidate" as const };
    const ref = contentRef("planning-review-finding", {
      ...body,
      origin,
    });
    return { ref, ...body, origin };
  });
  if (new Set(findings.map((finding) => finding.rootCauseKey)).size !== findings.length) {
    throw new Error("Planning Review root cause keys must be unique");
  }
  return findings;
}

function requirePlanningScope(
  value: unknown,
): PlanningReviewSubjectFinding["scopeRelation"] {
  if (
    value !== "current_plan" &&
    value !== "governing_contract" &&
    value !== "outside_current_scope"
  ) {
    throw new Error("Planning Review finding scope relation is invalid");
  }
  return value;
}

function requireAffectedSubjectIds(
  value: unknown,
  expectedSubjectIds: string[],
): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("Planning Review finding must name affected subjects");
  }
  const affected = [...new Set(value.map((item) =>
    requireString(item, "Planning Review affected subject id"),
  ))].sort();
  const expected = new Set(expectedSubjectIds);
  if (affected.some((subjectId) => !expected.has(subjectId))) {
    throw new Error("Planning Review finding names a subject outside the candidate");
  }
  return affected;
}

function requirePriorFindingVerdicts(
  value: unknown,
  priorFindings: PlanningReviewSubjectFinding[],
): PlanningReviewFindingVerdict[] {
  if (!Array.isArray(value) || value.length !== priorFindings.length) {
    throw new Error("Planning re-review must judge every frozen finding");
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
      "Planning re-review root cause key",
    );
    const finding = byRootCause.get(rootCauseKey);
    if (!finding || seen.has(rootCauseKey)) {
      throw new Error("Planning re-review finding verdicts must be exact and unique");
    }
    seen.add(rootCauseKey);
    if (submitted.verdict !== "resolved" && submitted.verdict !== "unresolved") {
      throw new Error("Planning re-review finding verdict is invalid");
    }
    return {
      findingRef: finding.ref,
      verdict: submitted.verdict,
      observation: requireString(
        submitted.observation,
        "Planning re-review observation",
      ),
    };
  });
}
