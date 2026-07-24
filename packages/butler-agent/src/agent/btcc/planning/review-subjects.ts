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
  priorFindings: PlanningReviewSubjectFinding[] = [],
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
    const findings = requireSubjectFindings(
      entry.findings,
      expectedSubject,
      priorFindings,
    );
    const hasBlockingFinding = findings.some(
      (finding) => finding.recommendedDisposition === "required_now",
    );
    if ((entry.verdict === "failed") !== hasBlockingFinding) {
      throw new Error("Planning Review subject verdict conflicts with required-now findings");
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
  requireCompleteRootFindingAttachments(coverage);
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
      if (finding.recommendedDisposition !== "required_now") continue;
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
  subject: PlanningReviewSubject,
  priorFindings: PlanningReviewSubjectFinding[],
): PlanningReviewSubjectFinding[] {
  if (!Array.isArray(value)) {
    throw new Error(`Planning Review ${subject.subjectId} findings must be an array`);
  }
  return value.map((item, index) => {
    const finding = requireRecord(
      item,
      `Planning Review ${subject.subjectId} finding[${index}]`,
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
    const body = {
      rootCauseKey: requireString(
        finding.rootCauseKey,
        "Planning Review subject finding root cause key",
      ),
      affectedSubjectIds: requireAffectedSubjectIds(
        finding.affectedSubjectIds,
        subject.subjectId,
        priorFindings.length === 0
          ? undefined
          : priorFindings.find((item) => item.ref.id === finding.priorFindingId),
      ),
      dimension: finding.dimension as PlanningReviewDimension,
      message: requireString(finding.message, "Planning Review subject finding message"),
      priority,
      recommendedDisposition,
    };
    if (recommendedDisposition === "required_now" && priorFindings.length > 0) {
      const priorFindingId = requireString(
        finding.priorFindingId,
        "Planning Review prior finding id",
      );
      const prior = priorFindings.find((item) => item.ref.id === priorFindingId);
      if (
        finding.findingOrigin !== "prior_finding" ||
        !prior ||
        prior.rootCauseKey !== body.rootCauseKey ||
        !sameStrings(prior.affectedSubjectIds, body.affectedSubjectIds) ||
        prior.dimension !== body.dimension ||
        prior.message !== body.message ||
        prior.priority !== body.priority
      ) {
        throw new Error("Planning re-review changed its frozen finding");
      }
      return prior;
    }
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
}

function requireAffectedSubjectIds(
  value: unknown,
  currentSubjectId: string,
  prior?: PlanningReviewSubjectFinding,
): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("Planning Review finding must name affected subjects");
  }
  const affected = [...new Set(value.map((item) =>
    requireString(item, "Planning Review affected subject id"),
  ))].sort();
  if (!affected.includes(currentSubjectId)) {
    throw new Error("Planning Review finding is not attached to its current subject");
  }
  if (prior && !sameStrings(prior.affectedSubjectIds, affected)) {
    throw new Error("Planning re-review changed affected subjects");
  }
  return affected;
}

function requireCompleteRootFindingAttachments(
  subjects: PlanningReviewSubjectCoverage[],
): void {
  const attachments = new Map<string, Set<string>>();
  const findings = new Map<string, PlanningReviewSubjectFinding>();
  const rootCauseRefs = new Map<string, string>();
  for (const subject of subjects) {
    for (const finding of subject.findings) {
      const priorRef = rootCauseRefs.get(finding.rootCauseKey);
      if (priorRef && priorRef !== finding.ref.id) {
        throw new Error("Planning Review redefined one root cause");
      }
      rootCauseRefs.set(finding.rootCauseKey, finding.ref.id);
      findings.set(finding.ref.id, finding);
      const attached = attachments.get(finding.ref.id) ?? new Set<string>();
      attached.add(subject.subjectId);
      attachments.set(finding.ref.id, attached);
    }
  }
  for (const [findingId, finding] of findings) {
    const attached = [...(attachments.get(findingId) ?? [])].sort();
    if (!sameStrings(attached, finding.affectedSubjectIds)) {
      throw new Error("Planning Review root finding attachments are incomplete");
    }
  }
}

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length &&
    left.every((value, index) => value === right[index]);
}
