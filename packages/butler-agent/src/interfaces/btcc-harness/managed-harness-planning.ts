export function submitInitialPlan(state: Record<string, unknown>) {
  return {
    kind: "plan_candidate",
    ...findingDecisions(state),
    ...governingSelection(state),
    strategy: "조사와 가이드 완성을 독립적으로 검토 가능한 두 Task로 구성한다",
    works: [{
      logicalId: "customer-service-guide",
      outcome: "고객 응대 운영 가이드 완성",
      dependencyWorkIds: [],
      tasks: [
        taskSubmission({
          logicalId: "research-principles",
          intendedOutcome: "고객 응대 핵심 원칙을 조사하고 정리",
          executionOrdinal: 1,
          dependencyTaskIds: [],
          criterion: "요청한 고객 응대 원칙이 조사 결과에 포함된다",
          question: "조사 결과가 원래 요청의 핵심 원칙을 충족하는가?",
          goalField: "request",
          outcome: state.requiredOutcomeId,
        }),
        taskSubmission({
          logicalId: "write-guide",
          intendedOutcome: "조사 결과를 짧고 실행 가능한 가이드로 작성",
          executionOrdinal: 2,
          dependencyTaskIds: ["research-principles"],
          criterion: "가이드가 짧고 실행 가능한 적용 지침을 제공한다",
          question: "최종 가이드가 의도한 결과와 완료 조건을 충족하는가?",
          goalField: "intended_result",
          outcome: state.requiredOutcomeId,
        }),
      ],
    }],
    ...emptyPlanningConsiderations(),
  };
}

export function submitArtifactPlan(state: Record<string, unknown>) {
  const targetScopeRef = "repository:harness-artifact-target";
  const targetPath = "harness-artifact-target";
  const mutatingArtifactPolicy = {
    kind: "workspace_artifact",
    workspacePath: targetPath,
    mutationScope: { kind: "contained_paths", writablePaths: ["guide.md"] },
  };
  const observingArtifactPolicy = {
    kind: "workspace_artifact",
    workspacePath: targetPath,
    mutationScope: { kind: "read_only" },
  };
  return {
    kind: "plan_candidate",
    ...governingSelection(state),
    strategy: "원본을 건드리지 않고 구현, 통합 검토, 승인 후 프로모션을 분리한다",
    works: [{
      logicalId: "artifact-change",
      outcome: "격리 구현과 통합 검토를 마친 프로모션 후보 완성",
      dependencyWorkIds: [],
      tasks: [
        {
          ...taskSubmission({
            logicalId: "implement-artifact",
            intendedOutcome: "격리 작업공간에서 요청한 변경을 구현한다",
            executionOrdinal: 1,
            dependencyTaskIds: [],
            criterion: "격리 구현이 원래 요청을 충족한다",
            question: "구현 결과가 요청한 변경을 포함하는가?",
            goalField: "request",
            outcome: state.requiredOutcomeId,
          }),
          artifactPolicy: mutatingArtifactPolicy,
        },
        {
          ...taskSubmission({
            logicalId: "integrate-artifact",
            intendedOutcome: "완전한 격리 결과를 통합 검증한다",
            executionOrdinal: 2,
            dependencyTaskIds: ["implement-artifact"],
            criterion: "통합 결과가 완료 조건을 충족한다",
            question: "격리된 전체 결과가 의도한 완료 조건을 만족하는가?",
            goalField: "intended_result",
            outcome: state.requiredOutcomeId,
          }),
          artifactPolicy: observingArtifactPolicy,
        },
        {
          ...taskSubmission({
            logicalId: "promote-artifact",
            intendedOutcome: "승인된 격리 결과의 정확한 동일성을 원본에 반영한다",
            executionOrdinal: 3,
            dependencyTaskIds: ["integrate-artifact"],
            criterion: "프로모션 영수증이 승인된 후보와 동일하다",
            question: "승인된 후보와 반영 결과의 동일성이 확인되는가?",
            goalField: "intended_result",
            outcome: state.requiredOutcomeId,
          }),
          effectClass: "external_effect",
          artifactPolicy: { kind: "repository_promotion", targetPath },
        },
      ],
    }],
    promotionSelectors: [{
      implementationTaskIds: ["implement-artifact"],
      integrationTaskId: "integrate-artifact",
      promotionTaskId: "promote-artifact",
    }],
    risks: [],
    assumptions: [],
    effectIntents: [{
      occurrenceKey: "promote-harness-artifact-v1",
      taskId: "promote-artifact",
      actionKind: "repository_promotion",
      action: "replace the complete approved target",
      payload: targetScopeRef,
      desiredOutcome: "the target equals the reviewed isolated candidate",
      sourceGoalFieldIds: ["intended_result"],
      sourceRequiredOutcomeRefs: [state.requiredOutcomeId],
    }],
    integrationCriteria: [{
      logicalId: "artifact-candidate-integration",
      statement: "the complete isolated candidate remains compatible before promotion",
      sourceGoalFieldIds: ["request", "intended_result"],
      sourceRequiredOutcomeRefs: [state.requiredOutcomeId],
      participatingTaskIds: ["implement-artifact", "integrate-artifact"],
      integrationTaskId: "integrate-artifact",
      promotionTaskId: "promote-artifact",
      observableCompatibility: "disposable validation passes against the complete candidate",
    }],
  };
}

export function submitPlanningReview(
  state: Record<string, unknown>,
  reviseFirst: boolean,
  reviewCount: number,
) {
  const revisionRequired = reviseFirst && reviewCount === 1;
  if (revisionRequired) {
    return {
      kind: "planning_review",
      verdict: "revision_required",
      coverage: planningReviewCoverage("task_executability"),
      subjects: planningReviewSubjects(
        state,
        "task:",
        "task_executability",
        "두 번째 Task의 완료 조건을 더 명확히 표현해야 한다",
      ),
    };
  }
  return {
    kind: "planning_review",
    reviewedEffectIntentRefs: nestedRecordRefs(state, "effectIntents"),
    reviewedIntegrationCriterionRefs: nestedRecordRefs(state, "integrationCriteria"),
    verdict: "accepted",
    coverage: planningReviewCoverage(),
    subjects: planningReviewSubjects(state),
  };
}

function planningReviewCoverage(
  failedDimension?: string,
) {
  return [
    "original_goal",
    "governing_specs",
    "work_cohesion",
    "task_executability",
    "dependencies",
    "verification_integration",
    "effect_authority",
    "artifact_lifecycle",
  ].map((dimension) => dimension === failedDimension
    ? { dimension, verdict: "failed" }
    : { dimension, verdict: "passed" });
}

function planningReviewSubjects(
  state: Record<string, unknown>,
  failedPrefix?: string,
  dimension?: string,
  message?: string,
) {
  const subjects = Array.isArray(state.requiredReviewSubjects)
    ? state.requiredReviewSubjects
    : [];
  let failed = false;
  return subjects.map((item) => {
    const subject = asRecord(item);
    const subjectId = String(subject.subjectId);
    if (!failed && failedPrefix && subjectId.startsWith(failedPrefix)) {
      failed = true;
      return {
        subjectId,
        verdict: "failed",
        findings: [{
          rootCauseKey: "clarify-second-task-completion",
          affectedSubjectIds: [subjectId],
          dimension,
          message,
          priority: "P1",
          recommendedDisposition: "required_now",
          findingOrigin: "initial_review",
        }],
      };
    }
    return { subjectId, verdict: "passed", findings: [] };
  });
}

function findingDecisions(state: Record<string, unknown>) {
  const prior = asRecord(state.priorPlanningReview);
  if (!Array.isArray(prior.reviewedSubjects)) return {};
  const findingIds = prior.reviewedSubjects.flatMap((item) => {
    const subject = asRecord(item);
    if (!Array.isArray(subject.findings)) return [];
    return subject.findings.flatMap((finding) => {
      const value = asRecord(finding);
      const ref = asRecord(value.ref);
      return value.recommendedDisposition === "required_now" && typeof ref.id === "string"
        ? [ref.id]
        : [];
    });
  });
  return findingIds.length === 0 ? {} : {
    findingDecisions: findingIds.map((findingId) => ({
      findingId,
      decision: "apply_now",
      rationale: "리뷰가 지적한 현재 범위의 결함을 이번 계획에서 수정한다",
    })),
  };
}

function governingSelection(state: Record<string, unknown>): Record<string, unknown> {
  const available = asArray(state.availableSpecs);
  const logicalIds = available
    .map((spec) => asRecord(spec).logicalId)
    .filter((logicalId): logicalId is string => typeof logicalId === "string");
  return logicalIds.length > 0 ? { governingSpecSelections: logicalIds } : {};
}

function taskSubmission(input: {
  logicalId: string;
  intendedOutcome: string;
  executionOrdinal: number;
  dependencyTaskIds: string[];
  criterion: string;
  question: string;
  goalField: string;
  outcome: unknown;
}) {
  return {
    logicalId: input.logicalId,
    intendedOutcome: input.intendedOutcome,
    executionOrdinal: input.executionOrdinal,
    dependencyTaskIds: input.dependencyTaskIds,
    effectClass: "none",
    targetScopeRefs: ["session:managed-guide"],
    criteria: [{
      statement: input.criterion,
      question: input.question,
      sourceGoalFieldIds: [input.goalField],
      sourceRequiredOutcomeRefs: [input.outcome],
    }],
  };
}

function emptyPlanningConsiderations() {
  return {
    risks: [],
    assumptions: [],
    effectIntents: [],
    integrationCriteria: [],
  };
}

function nestedRecordRefs(state: Record<string, unknown>, key: string): unknown[] {
  return asArray(nestedValue(state, "planCandidate", "candidate", key))
    .map((record) => asRecord(record).ref);
}

function nestedValue(state: Record<string, unknown>, ...path: string[]): unknown {
  let value: unknown = state;
  for (const key of path) value = asRecord(value)[key];
  return value;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
