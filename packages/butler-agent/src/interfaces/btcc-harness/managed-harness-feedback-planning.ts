import { submitInitialPlan } from "./managed-harness-planning.ts";

export type HarnessCorrectionKind =
  | "implementation_repair"
  | "governing_revision"
  | "authority_scope_revision";

export function submitFeedbackPlan(
  state: Record<string, unknown>,
  correctionKind: HarnessCorrectionKind,
  revalidateAcceptedTask = false,
) {
  if (correctionKind === "implementation_repair") {
    return {
      kind: "feedback_plan_candidate",
      ...feedbackPlanningFindingDecisions(state),
      correctionKind,
      correctionAction: "같은 Task에서 고객 응대 원칙별 실행 지침을 추가한다",
    };
  }
  return {
    kind: "feedback_plan_candidate",
    ...feedbackPlanningFindingDecisions(state),
    correctionKind,
    correctionAction: "리뷰 피드백에 맞춰 Task 경계와 의존 순서를 다시 승인한다",
    revisedPlan: revalidateAcceptedTask
      ? unchangedTaskRevision(state)
      : revisedPlanSubmission(state),
    impactMap: asArray(state.taskImpactIndex).map((taskState, index) => ({
      priorTaskLogicalId: asRecord(asRecord(taskState).task).taskLogicalId,
      disposition: revalidateAcceptedTask && index === 0
        ? "revalidate"
        : index === 0 || revalidateAcceptedTask
          ? "rework"
          : "replan",
      ...(index === 0 || revalidateAcceptedTask
        ? { successorTaskLogicalId: asRecord(asRecord(taskState).task).taskLogicalId }
        : {}),
      reason: revalidateAcceptedTask && index === 0
        ? "변경된 governing authority 아래에서 기존 통과 결과를 다시 검토해야 한다"
        : index === 0
          ? "리뷰에서 발견한 구현 누락을 같은 Task에서 다시 수행해야 한다"
          : "변경된 Task 경계에 맞춰 후속 작업을 다시 계획해야 한다",
    })),
    ...(correctionKind === "authority_scope_revision"
      ? { authorityChange: "사용자가 승인한 확장 범위를 적용한다" }
      : {}),
  };
}

export function submitFeedbackPlanningReview(
  state: Record<string, unknown>,
  reviseFirst: boolean,
  reviewCount: number,
) {
  const revisionRequired = reviseFirst && reviewCount === 1;
  const prior = asRecord(state.previousFeedbackPlanningReview);
  const priorFindings = asArray(prior.reviewedFindings)
    .filter((finding) => asRecord(finding).recommendedDisposition === "required_now");
  return {
    kind: "feedback_planning_review",
    verdict: revisionRequired ? "revision_required" : "accepted",
    ...(revisionRequired ? { revisionTarget: "feedback_plan" } : {}),
    findings: revisionRequired
      ? [{
          rootCauseKey: "limit-correction-to-failed-task",
          statement: "보완 행동을 실패한 Task 범위로 더 명확히 제한해야 한다",
          priority: "P1",
          scopeRelation: "current_correction",
          recommendedDisposition: "required_now",
          dispositionRationale: "현재 교정 계획이 동결된 Finding보다 넓다",
          findingOrigin: "initial_review",
        }]
      : [],
    ...(priorFindings.length > 0
      ? {
          priorFindingVerdicts: priorFindings.map((finding) => ({
            rootCauseKey: asRecord(finding).rootCauseKey,
            verdict: "resolved",
            observation: "수정된 교정 계획이 이 동결 Finding을 해소했다",
          })),
        }
      : {}),
  };
}

export function reviseFeedbackIntentReview() {
  return {
    kind: "feedback_planning_review",
    verdict: "revision_required",
    revisionTarget: "feedback_intent",
    findings: [{
      rootCauseKey: "repair-requires-governing-task-boundary",
      statement: "The accepted local repair cannot mutate a predecessor-owned target.",
      priority: "P0",
      scopeRelation: "governing_contract",
      recommendedDisposition: "required_now",
      dispositionRationale: "The correction kind must return to governing Planning.",
      findingOrigin: "initial_review",
    }],
  };
}

export function feedbackFindingDecisions(
  state: Record<string, unknown>,
  decision: "apply_now" | "dispute" | "split_to_backlog" = "apply_now",
) {
  const source = asRecord(state.correctionSource);
  const review = asRecord(source.review);
  const findingIds = asArray(review.findings).flatMap((item) => {
    const finding = asRecord(item);
    const ref = asRecord(finding.ref);
    return finding.recommendedDisposition === "required_now" && typeof ref.id === "string"
      ? [ref.id]
      : [];
  });
  return findingIds.length === 0 ? {} : {
    findingDecisions: findingIds.map((findingId) => ({
      findingId,
      decision,
      rationale: decision === "apply_now"
        ? "현재 Task의 수용 기준을 막는 결함을 이번 수정에서 해결한다"
        : decision === "dispute"
          ? "현재 결과가 이미 수용 기준을 충족하므로 최초 판단에 이의를 제기한다"
          : "현재 요청의 완료 조건이 아니므로 별도 backlog 후보로 분리한다",
    })),
  };
}

function feedbackPlanningFindingDecisions(state: Record<string, unknown>) {
  const prior = asRecord(state.previousFeedbackPlanningReview);
  const ids = asArray(prior.reviewedFindings).flatMap((item) => {
    const finding = asRecord(item);
    const ref = asRecord(finding.ref);
    return finding.recommendedDisposition === "required_now" && typeof ref.id === "string"
      ? [ref.id]
      : [];
  });
  return ids.length === 0 ? {} : {
    findingDecisions: ids.map((findingId) => ({
      findingId,
      decision: "apply_now",
      rationale: "현재 CorrectionScope를 막는 리뷰 결함을 수정한다",
    })),
  };
}

function unchangedTaskRevision(state: Record<string, unknown>) {
  const { kind: _kind, ...revision } = submitInitialPlan(state);
  return {
    ...revision,
    strategy: "기존 Task 계약을 보존하고 변경된 governing authority 아래에서 재검토한다",
  };
}

function revisedPlanSubmission(state: Record<string, unknown>) {
  return {
    ...governingSelection(state),
    strategy: "리뷰 피드백에 따라 조사와 가이드 작성 경계를 명확히 다시 구성한다",
    works: [{
      logicalId: "customer-service-guide",
      outcome: "고객 응대 운영 가이드 완성",
      dependencyWorkIds: [],
      tasks: [
        taskSubmission({
          logicalId: "research-principles",
          intendedOutcome: "신뢰 가능한 고객 응대 원칙과 적용 범위를 함께 조사한다",
          executionOrdinal: 1,
          dependencyTaskIds: [],
          criterion: "요청한 고객 응대 원칙과 적용 범위가 조사 결과에 포함된다",
          question: "조사 결과가 원래 요청의 핵심 원칙과 범위를 충족하는가?",
          goalField: "request",
          outcome: state.requiredOutcomeId,
        }),
        taskSubmission({
          logicalId: "write-guide",
          intendedOutcome: "승인된 조사 결과를 짧고 실행 가능한 가이드로 작성한다",
          executionOrdinal: 2,
          dependencyTaskIds: ["research-principles"],
          criterion: "가이드가 짧고 실행 가능한 적용 지침을 제공한다",
          question: "최종 가이드가 의도한 결과와 완료 조건을 충족하는가?",
          goalField: "intended_result",
          outcome: state.requiredOutcomeId,
        }),
      ],
    }],
    risks: [],
    assumptions: [],
    effectIntents: [],
    integrationCriteria: [],
  };
}

function governingSelection(state: Record<string, unknown>): Record<string, unknown> {
  const logicalIds = asArray(state.availableSpecs)
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

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
