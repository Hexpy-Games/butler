const GOAL_REVIEW_SUBJECT_IDS = [
  "goal:request",
  "goal:intended_result",
  "goal:acceptance_intent",
  "goal:artifact_persistence",
  "goal:governing_specs",
  "goal:non_goals",
  "lens:requested_content",
  "lens:related_memory",
  "lens:connected_current_knowledge",
  "lens:user_preferences_and_resolution_style",
  "lens:expert_perspective",
  "lens:intended_result_and_acceptance",
] as const;

export function goalReviewSubjects(failed?: string) {
  return GOAL_REVIEW_SUBJECT_IDS.map((subjectId) => ({
    subjectId,
    verdict: subjectId === failed ? "failed" : "passed",
  }));
}

export function goalPriorFindingVerdicts(state: Record<string, unknown>) {
  const findings = goalReviewFindings(state);
  return findings.length === 0 ? {} : {
    priorFindingVerdicts: findings.map((item) => ({
      rootCauseKey: asRecord(item).rootCauseKey,
      verdict: "resolved",
      observation: "수정된 GoalContract가 동결된 누락을 해소했다",
    })),
  };
}

export function goalFindingDecisions(state: Record<string, unknown>) {
  const findings = goalReviewFindings(state);
  return findings.length === 0 ? {} : {
    findingDecisions: findings.map((item) => ({
      rootCauseKey: asRecord(item).rootCauseKey,
      decision: "apply_now",
      rationale: "동결된 Goal 누락을 현재 수정에서 복원한다",
    })),
  };
}

function goalReviewFindings(state: Record<string, unknown>): unknown[] {
  const revision = asRecord(state.goalRevision);
  return asArray(asRecord(revision.review).findings);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
