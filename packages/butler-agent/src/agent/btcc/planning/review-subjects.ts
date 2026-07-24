import {
  requireRecord,
  requireString,
  type ContentRef,
} from "../core/index.ts";
import type {
  PlanningCandidate,
  PlanningReviewCoverage,
  PlanningReviewDimension,
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
    const findings = requireSubjectFindings(entry.findings, subjectId);
    if (entry.verdict === "passed" && findings.length > 0) {
      throw new Error("Passed Planning Review subject cannot contain findings");
    }
    if (entry.verdict === "failed" && findings.length === 0) {
      throw new Error("Failed Planning Review subject requires findings");
    }
    return {
      ...expectedSubject,
      verdict: entry.verdict,
      findings,
    } satisfies PlanningReviewSubjectCoverage;
  });
  if (seen.size !== expected.length) {
    throw new Error("Planning Review subjects must be exact, unique, and complete");
  }
  return coverage;
}

export function requireDimensionCoverage(
  value: unknown,
  subjects: PlanningReviewSubjectCoverage[],
): PlanningReviewCoverage[] {
  if (!Array.isArray(value) || value.length !== PLANNING_REVIEW_DIMENSIONS.length) {
    throw new Error("Planning Review must cover every review dimension");
  }
  const findingsByDimension = new Map<PlanningReviewDimension, string[]>(
    PLANNING_REVIEW_DIMENSIONS.map((dimension) => [dimension, []]),
  );
  for (const subject of subjects) {
    for (const finding of subject.findings) {
      findingsByDimension.get(finding.dimension)!.push(finding.message);
    }
  }
  const seen = new Set<PlanningReviewDimension>();
  const coverage = value.map((item, index) => {
    const entry = requireRecord(item, `Planning Review coverage[${index}]`);
    const dimension = entry.dimension as PlanningReviewDimension;
    if (!PLANNING_REVIEW_DIMENSIONS.includes(dimension) || seen.has(dimension)) {
      throw new Error("Planning Review coverage dimensions must be unique and complete");
    }
    seen.add(dimension);
    const findings = [...new Set(findingsByDimension.get(dimension) ?? [])];
    const expectedVerdict: "passed" | "failed" = findings.length > 0
      ? "failed"
      : "passed";
    if (entry.verdict !== expectedVerdict) {
      throw new Error("Planning Review dimension verdict conflicts with subject findings");
    }
    return { dimension, verdict: expectedVerdict, findings };
  });
  if (seen.size !== PLANNING_REVIEW_DIMENSIONS.length) {
    throw new Error("Planning Review coverage dimensions must be unique and complete");
  }
  return coverage;
}

function subject(
  subjectId: string,
  kind: PlanningReviewSubjectKind,
  ref: ContentRef,
): PlanningReviewSubject {
  return { subjectId, kind, subjectRef: ref };
}

function requireSubjectFindings(
  value: unknown,
  subjectId: string,
): PlanningReviewSubjectFinding[] {
  if (!Array.isArray(value)) {
    throw new Error(`Planning Review ${subjectId} findings must be an array`);
  }
  return value.map((item, index) => {
    const finding = requireRecord(item, `Planning Review ${subjectId} finding[${index}]`);
    if (!PLANNING_REVIEW_DIMENSIONS.includes(finding.dimension as PlanningReviewDimension)) {
      throw new Error("Planning Review subject finding dimension is invalid");
    }
    return {
      dimension: finding.dimension as PlanningReviewDimension,
      message: requireString(finding.message, "Planning Review subject finding message"),
    };
  });
}
