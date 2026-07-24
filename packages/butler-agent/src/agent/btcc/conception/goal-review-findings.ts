import {
  contentRef,
  requireRecord,
  requireString,
} from "../core/index.ts";
import type {
  GoalContractCandidateProduct,
  GoalContractRevisionRequiredProduct,
  GoalReviewFinding,
  GoalReviewFindingVerdict,
} from "./managed-contracts.ts";
import { GOAL_REVIEW_SUBJECTS } from "./submission-schemas.ts";

export function decodeInitialGoalFindings(
  value: unknown,
  candidate: GoalContractCandidateProduct,
): GoalReviewFinding[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("Goal Contract revision requires a complete FindingSet");
  }
  const rootCauses = new Set<string>();
  return value.map((item, index) => {
    const submitted = requireRecord(item, `Goal Review finding[${index}]`);
    const rootCauseKey = requireString(
      submitted.rootCauseKey,
      `Goal Review finding[${index}].rootCauseKey`,
    );
    if (rootCauses.has(rootCauseKey)) {
      throw new Error("Goal Review root cause keys must be unique");
    }
    rootCauses.add(rootCauseKey);
    const body = {
      rootCauseKey,
      affectedSubjectIds: requireStringList(
        submitted.affectedSubjectIds,
        `Goal Review finding[${index}].affectedSubjectIds`,
      ),
      statement: requireString(
        submitted.finding,
        `Goal Review finding[${index}].finding`,
      ),
      priority: requireGoalPriority(submitted.priority),
      scopeRelation: requireGoalScope(submitted.scopeRelation),
      recommendedDisposition: "required_now" as const,
      dispositionRationale: requireString(
        submitted.dispositionRationale,
        `Goal Review finding[${index}].dispositionRationale`,
      ),
      candidateRef: candidate.candidate.ref,
    };
    return { ref: contentRef("goal-review-finding", body), ...body };
  }).sort((left, right) => priorityOrder(left.priority) - priorityOrder(right.priority));
}

export function decodePriorGoalFindingVerdicts(
  value: unknown,
  frozenFindings: GoalReviewFinding[],
): GoalReviewFindingVerdict[] {
  if (frozenFindings.length === 0) return [];
  if (!Array.isArray(value) || value.length !== frozenFindings.length) {
    throw new Error("Goal re-review must judge every frozen finding");
  }
  const byRootCause = new Map(frozenFindings.map((finding) => [
    finding.rootCauseKey,
    finding,
  ]));
  const seen = new Set<string>();
  return value.map((item, index) => {
    const submitted = requireRecord(item, `Goal priorFindingVerdict[${index}]`);
    const rootCauseKey = requireString(
      submitted.rootCauseKey,
      `Goal priorFindingVerdict[${index}].rootCauseKey`,
    );
    const finding = byRootCause.get(rootCauseKey);
    if (!finding || seen.has(rootCauseKey)) {
      throw new Error("Goal re-review finding verdicts must be exact and unique");
    }
    seen.add(rootCauseKey);
    if (submitted.verdict !== "resolved" && submitted.verdict !== "unresolved") {
      throw new Error("Goal re-review finding verdict is invalid");
    }
    return {
      findingRef: finding.ref,
      verdict: submitted.verdict,
      observation: requireString(
        submitted.observation,
        `Goal priorFindingVerdict[${index}].observation`,
      ),
    };
  });
}

export function unresolvedGoalFindings(
  frozen: GoalReviewFinding[],
  verdicts: GoalReviewFindingVerdict[],
): GoalReviewFinding[] {
  return verdicts
    .filter((verdict) => verdict.verdict === "unresolved")
    .map((verdict) => frozen.find((finding) =>
      sameRef(finding.ref, verdict.findingRef))!);
}

export function preserveGoalReviewLineage(
  candidate: GoalContractCandidateProduct,
  prior?: GoalContractRevisionRequiredProduct,
): void {
  if (!prior) return;
  const origin = candidate.candidate.revisionOrigin;
  if (
    origin.kind !== "review_revision" ||
    !sameRef(origin.previousCandidateRef, prior.candidate.ref) ||
    !sameRef(origin.reviewRef, prior.review.ref) ||
    !sameRef(origin.findingSetRef, prior.review.findingSetRef) ||
    origin.findingDecisions.length !== prior.review.findings.length
  ) {
    throw new Error("Goal re-review changed its frozen review lineage");
  }
}

export function decodeGoalSubjectCoverage(value: unknown) {
  if (!Array.isArray(value) || value.length !== GOAL_REVIEW_SUBJECTS.length) {
    throw new Error("Goal Contract Review must judge every closed subject");
  }
  const expected = new Set<string>(GOAL_REVIEW_SUBJECTS);
  const seen = new Set<string>();
  return value.map((item, index) => {
    const subject = requireRecord(item, `Goal Review subject[${index}]`);
    const subjectId = requireString(
      subject.subjectId,
      `Goal Review subject[${index}].subjectId`,
    );
    if (!expected.has(subjectId) || seen.has(subjectId)) {
      throw new Error("Goal Contract Review subjects must be exact and unique");
    }
    seen.add(subjectId);
    if (subject.verdict !== "passed" && subject.verdict !== "failed") {
      throw new Error("Goal Contract Review subject verdict is invalid");
    }
    return { subjectId, verdict: subject.verdict };
  });
}

export function requireGoalFindingCoverage(
  subjects: Array<{ subjectId: string; verdict: unknown }>,
  findings: GoalReviewFinding[],
): void {
  for (const subject of subjects) {
    const hasFinding = findings.some((finding) =>
      finding.affectedSubjectIds.includes(subject.subjectId));
    if ((subject.verdict === "failed") !== hasFinding) {
      throw new Error("Goal Contract Review subject verdict conflicts with findings");
    }
  }
}

function requireStringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} is empty`);
  }
  return [...new Set(value.map((item, index) =>
    requireString(item, `${label}[${index}]`)))];
}

function requireGoalPriority(value: unknown): "P0" | "P1" | "P2" {
  if (value !== "P0" && value !== "P1" && value !== "P2") {
    throw new Error("Goal Review finding priority is invalid");
  }
  return value;
}

function requireGoalScope(value: unknown): "current_goal" | "governing_contract" {
  if (value !== "current_goal" && value !== "governing_contract") {
    throw new Error("Goal Review finding scope relation is invalid");
  }
  return value;
}

function priorityOrder(priority: "P0" | "P1" | "P2"): number {
  return { P0: 0, P1: 1, P2: 2 }[priority];
}

function sameRef(
  left: { id: string; sha256: string },
  right: { id: string; sha256: string },
): boolean {
  return left.id === right.id && left.sha256 === right.sha256;
}
