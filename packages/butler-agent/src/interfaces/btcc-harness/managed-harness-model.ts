import type { BtccRuntimeDependencies } from "../../agent/btcc/index.ts";
import {
  submitFeedbackPlan,
  submitFeedbackPlanningReview,
  submitArtifactPlan,
  submitInitialPlan,
  submitPlanningReview,
  type HarnessCorrectionKind,
} from "./managed-harness-planning.ts";
import { submitConsolidation, submitReport } from "./managed-harness-finalization.ts";

type SelectedModel = BtccRuntimeDependencies["model"];
type PhaseEnvelope = Parameters<SelectedModel["runRound"]>[0];
type ProviderRoundValue = Awaited<ReturnType<SelectedModel["runRound"]>>;

export class ManagedHarnessModel implements SelectedModel {
  callCount = 0;
  readonly phases: string[] = [];
  private reviewCount = 0;
  private planningReviewCount = 0;
  private goalReviewCount = 0;
  private feedbackPlanningReviewCount = 0;
  private deferralSubmitted = false;
  private consolidationRepairSubmitted = false;

  constructor(
    private readonly failFirstReview: boolean,
    private readonly reviseFirstPlan = false,
    private readonly reviseFirstCorrection = false,
    private readonly correctionKind: HarnessCorrectionKind = "implementation_repair",
    private readonly artifactPlan = false,
    private readonly deferralPhase?: "planning" | "promotion",
    private readonly chooseContinuation = false,
    private readonly repairConsolidation = false,
    private readonly reviseFirstGoal = false,
  ) {}

  async runRound(envelope: PhaseEnvelope): Promise<ProviderRoundValue> {
    this.callCount += 1;
    this.phases.push(envelope.phase);
    const submission = this.submissionFor(envelope);
    const identity = {
      provider: envelope.modelSelection.provider,
      model: envelope.modelSelection.model,
      reasoningEffort: envelope.modelSelection.reasoningEffort,
      controlsHash: envelope.modelSelection.controlsHash,
    };
    if (asRecord(submission).kind === "operation_requests") {
      return {
        kind: "operation_requests",
        requests: asArray(asRecord(submission).requests) as never,
        actualIdentity: identity,
      };
    }
    return {
      kind: "phase_submission",
      submission,
      actualIdentity: identity,
    };
  }

  private submissionFor(envelope: PhaseEnvelope): unknown {
    const state = asRecord(envelope.context.stateInput);
    switch (envelope.phase) {
      case "conception_opening":
        return {
          kind: "opening_continuation",
          message: "요청의 목표와 완료 조건을 정리한 뒤 작업 계획을 세우겠습니다.",
        };
      case "conception_deliberation": {
        const revision = asRecord(state.goalRevision);
        const personalizationRefs = [
          ...envelope.context.profileRefs,
          ...envelope.context.recentFeedbackRefs,
          ...envelope.context.mandatoryHotCacheRefs,
          ...envelope.context.optionalHotCacheRefs,
        ];
        return {
          kind: "goal_contract_candidate",
          request: "고객 응대 원칙을 조사한다",
          intendedResult: revision.kind === "goal_contract_revision_required"
            ? "조사 결과와 실행 지침을 모두 포함한 운영 가이드를 제공한다"
            : this.reviseFirstGoal
              ? "조사 없이 짧은 의견만 제공한다"
              : "짧고 실행 가능한 운영 가이드를 제공한다",
          acceptanceIntent: "원래 요청을 빠뜨리지 않은 운영 가이드가 완성된다",
          artifactPersistence: this.artifactPlan ? "required" : "not_required",
          nonGoals: ["프로젝트 파일이나 외부 시스템을 변경하지 않는다"],
          personalizationRefs,
          governingSpecLogicalIds: envelope.context.projectRef ? ["SPEC-HARNESS"] : [],
          lensAssessments: {
            requested_content: adopted("고객 응대 원칙 조사와 가이드 작성", ["request"]),
            related_memory: adopted("원래 의도를 끝까지 보존한다", ["intended_result"]),
            connected_current_knowledge: nonApplicable("일반 지식은 실행 맥락이며 새 목표가 아니다"),
            user_preferences_and_resolution_style: nonApplicable("간결한 표현은 출력 선호이며 새 목표가 아니다"),
            expert_perspective: nonApplicable("고객 경험 관점은 해석 수단이며 새 목표가 아니다"),
            intended_result_and_acceptance: adopted("실행 가능한 짧은 가이드가 완료 조건이다", ["intended_result"]),
          },
        };
      }
      case "contract_review":
        this.goalReviewCount += 1;
        if (this.reviseFirstGoal && this.goalReviewCount === 1) {
          return {
            kind: "goal_contract_review",
            strategy: "managed",
            verdict: "revision_required",
            findings: ["조사 수행과 실행 지침이라는 원래 요청의 필수 결과가 누락되었다"],
          };
        }
        return {
          kind: "goal_contract_review",
          strategy: "managed",
          verdict: "accepted",
          ...(this.chooseContinuation
            ? { continuationCandidateId: firstContinuationCandidateId(state) }
            : {}),
        };
      case "planning":
        if (this.deferralPhase === "planning" && !this.deferralSubmitted) {
          this.deferralSubmitted = true;
          return deferredForUserAuthority();
        }
        return this.artifactPlan ? submitArtifactPlan(state) : submitInitialPlan(state);
      case "planning_review":
        this.planningReviewCount += 1;
        return submitPlanningReview(
          state,
          this.reviseFirstPlan,
          this.planningReviewCount,
        );
      case "task_execution":
        if (
          this.deferralPhase === "promotion" && !this.deferralSubmitted &&
          executionTargetKind(state) === "repository_promotion"
        ) {
          this.deferralSubmitted = true;
          return deferredForUserAuthority("promotion_deferral");
        }
        if (this.artifactPlan && executionTargetKind(state) === "repository_promotion" &&
            envelope.operationResults.length === 0) {
          const target = asRecord(nestedValue(state, "executionTarget", "target"));
          return {
            kind: "operation_requests",
            requests: [{
              requestId: `repository-promotion:${envelope.binding.checkpointId}`,
              kind: "repository_promotion",
              capabilityRef: "harness:promote-artifact",
              authorizationRef: target.authorizationRef,
              candidateRef: target.candidateRef,
              resolutionRef: target.resolutionRef,
              baselineRef: target.baselineRef,
              finalSnapshotRef: target.finalSnapshotRef,
              input: { operation: "승인된 후보를 완전 대상 교환으로 반영한다" },
            }],
          };
        }
        if (this.artifactPlan && executionTargetKind(state) === "provisioned_workspace" &&
            envelope.operationResults.length === 0) {
          return {
            kind: "operation_requests",
            requests: [{
              requestId: `workspace-action:${envelope.binding.checkpointId}`,
              kind: "workspace_artifact_action",
              capabilityRef: "harness:write-artifact",
              workspaceRef: nestedValue(
                state, "executionTarget", "target", "workspaceRef",
              ),
              relativeTarget: "guide.md",
              input: { content: "승인된 작업 내용을 격리 작업공간에 작성한다" },
            }],
          };
        }
        return {
          kind: "result_candidate",
          resultSummary: this.reviewCount === 0 && this.failFirstReview
            ? "고객 응대의 기본 원칙만 초안으로 정리했다"
            : "고객 응대 원칙과 실행 지침을 함께 정리했다",
          observedStates: asArray(state.targetScopeRefs).map((targetScopeRef) => ({
            targetScopeRef,
            state: "present",
            description: "요청 범위에 맞는 운영 가이드 본문이 존재한다",
          })),
        };
      case "task_review": {
        if (this.artifactPlan && state.reviewSourceRef && envelope.operationResults.length === 0) {
          return {
            kind: "operation_requests",
            requests: [{
              requestId: `review-validation:${envelope.binding.checkpointId}`,
              kind: "review_validation",
              capabilityRef: "harness:validate-artifact",
              reviewSourceRef: state.reviewSourceRef,
              input: { command: "격리 복제본에서 결과를 검증한다" },
            }],
          };
        }
        this.reviewCount += 1;
        const resultCandidateRef = nestedRef(state, "resultCandidate", "result");
        const criteria = asArray(state.criteria);
        const questions = asArray(state.verificationQuestions);
        if (this.failFirstReview && this.reviewCount === 1) {
          return {
            kind: "task_review",
            resultCandidateRef,
            verdict: "not_passed",
            criterionVerdicts: criteria.map((criterion, index) => ({
              criterionRef: asRecord(criterion).ref,
              verificationQuestionRefs: questions
                .filter((question) => stableEqual(
                  asRecord(question).criterionRef,
                  asRecord(criterion).ref,
                ))
                .map((question) => asRecord(question).ref),
              verdict: index === 0 ? "not_satisfied" : "satisfied",
              observation: index === 0
                ? "초안에 실제 적용 지침이 빠져 있다"
                : "해당 기준은 충족한다",
              ...(index === 0
                ? {
                    findingCategory: this.correctionKind === "implementation_repair"
                      ? "implementation_nonconformance"
                      : this.correctionKind === "governing_revision"
                        ? "task_decomposition"
                        : "authority_contradiction",
                    finding: "수용 기준이 요구한 실행 지침을 구현하지 않았다",
                  }
                : {}),
            })),
          };
        }
        return {
          kind: "task_review",
          resultCandidateRef,
          verdict: "passed",
          criterionVerdicts: criteria.map((criterion) => ({
            criterionRef: asRecord(criterion).ref,
            verificationQuestionRefs: questions
              .filter((question) => stableEqual(
                asRecord(question).criterionRef,
                asRecord(criterion).ref,
              ))
              .map((question) => asRecord(question).ref),
            verdict: "satisfied",
            observation: "원칙과 실행 지침이 모두 포함되어 수용 기준을 충족한다",
          })),
        };
      }
      case "feedback_conception":
        return {
          kind: "feedback_intent",
          correctionKind: this.correctionKind,
          intendedCorrection: "누락된 실행 지침만 보완한다",
        };
      case "feedback_planning":
        return submitFeedbackPlan(state, this.correctionKind);
      case "feedback_planning_review":
        this.feedbackPlanningReviewCount += 1;
        return submitFeedbackPlanningReview(
          this.reviseFirstCorrection,
          this.feedbackPlanningReviewCount,
        );
      case "consolidation":
        if (this.repairConsolidation && !this.consolidationRepairSubmitted) {
          this.consolidationRepairSubmitted = true;
          return submitConsolidation(state, true);
        }
        return submitConsolidation(state, false);
      case "reporting":
        return submitReport(state);
    }
  }
}

function deferredForUserAuthority(kind = "managed_deferral") {
  return {
    kind,
    reason: "다음 단계에는 사용자의 명시적 승인이 필요하다",
    readiness: {
      kind: "user_authority",
      requiredAuthorityScopeRefs: ["authority:user-approval"],
    },
  };
}

function firstContinuationCandidateId(state: Record<string, unknown>): string {
  const candidate = asRecord(asArray(state.continuationCandidates)[0]);
  const id = candidate.candidateId;
  if (typeof id !== "string") throw new Error("Harness continuation candidate is missing");
  return id;
}

function executionTargetKind(state: Record<string, unknown>): unknown {
  return nestedValue(state, "executionTarget", "target", "kind");
}

function adopted(assessment: string, adoptedGoalFieldIds: string[]) {
  return { disposition: "adopted", assessment, adoptedGoalFieldIds };
}

function nonApplicable(assessment: string) {
  return { disposition: "non_applicable", assessment, adoptedGoalFieldIds: [] };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stableEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function nestedRef(
  state: Record<string, unknown>,
  productKey: string,
  recordKey: string,
): unknown {
  return asRecord(asRecord(state[productKey])[recordKey]).ref;
}

function nestedValue(
  state: Record<string, unknown>,
  ...path: string[]
): unknown {
  let value: unknown = state;
  for (const key of path) value = asRecord(value)[key];
  return value;
}
