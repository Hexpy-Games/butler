import type { BtccRuntimeDependencies } from "../../agent/btcc/index.ts";
import {
  feedbackFindingDecisions,
  submitFeedbackPlan,
  submitFeedbackPlanningReview,
  reviseFeedbackIntentReview,
  type HarnessCorrectionKind,
} from "./managed-harness-feedback-planning.ts";
import {
  submitArtifactPlan,
  submitInitialPlan,
  submitPlanningReview,
} from "./managed-harness-planning.ts";
import { submitConsolidation, submitReport } from "./managed-harness-finalization.ts";
import {
  continuationReviewDecision,
  submitOpening,
} from "./managed-harness-continuation.ts";
import {
  goalFindingDecisions,
  goalPriorFindingVerdicts,
  goalReviewSubjects,
} from "./managed-harness-goal.ts";
import {
  asArray,
  asRecord,
  executionTargetKind,
} from "./managed-harness-state.ts";
import { artifactExecutionOperation } from "./managed-harness-artifact-operation.ts";

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
  private feedbackConceptionCount = 0;
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
    private readonly failedReviewOrdinal = 1,
    private readonly revalidateAcceptedTask = false,
    private readonly reviewFindingDecision:
      "apply_now" | "dispute" | "split_to_backlog" = "apply_now",
    private readonly reviseFeedbackIntent = false,
    private readonly reopenArtifactTasks = false,
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
        return submitOpening(envelope.context, this.chooseContinuation);
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
          userArtifactTargetRequirement: this.artifactPlan
            ? "reviewed_artifact_bytes_at_admitted_target_required" : "no_user_artifact_target",
          nonGoals: ["프로젝트 파일이나 외부 시스템을 변경하지 않는다"],
          personalizationRefs,
          governingSpecApplications: envelope.context.projectRef
            ? [{
                logicalId: "SPEC-HARNESS",
                changeObligations: ["고객 응대 운영 가이드를 작성한다"],
                preservationConstraints: [],
              }]
            : [],
          lensAssessments: {
            requested_content: adopted("고객 응대 원칙 조사와 가이드 작성", ["request"]),
            related_memory: adopted("원래 의도를 끝까지 보존한다", ["intended_result"]),
            connected_current_knowledge: nonApplicable("일반 지식은 실행 맥락이며 새 목표가 아니다"),
            user_preferences_and_resolution_style: nonApplicable("간결한 표현은 출력 선호이며 새 목표가 아니다"),
            expert_perspective: nonApplicable("고객 경험 관점은 해석 수단이며 새 목표가 아니다"),
            intended_result_and_acceptance: adopted("실행 가능한 짧은 가이드가 완료 조건이다", ["intended_result"]),
          },
          ...goalFindingDecisions(state),
        };
      }
      case "contract_review":
        this.goalReviewCount += 1;
        if (this.reviseFirstGoal && this.goalReviewCount === 1) {
          return {
            kind: "goal_contract_review",
            strategy: "managed",
            verdict: "revision_required",
            subjects: goalReviewSubjects("goal:intended_result"),
            findings: [{
              rootCauseKey: "missing-required-result",
              affectedSubjectIds: ["goal:intended_result"],
              finding: "조사 수행과 실행 지침이라는 원래 요청의 필수 결과가 누락되었다",
              priority: "P1",
              scopeRelation: "current_goal",
              recommendedDisposition: "required_now",
              dispositionRationale: "원래 요청의 필수 결과를 직접 누락했다",
            }],
          };
        }
        return {
          kind: "goal_contract_review",
          strategy: "managed",
          verdict: "accepted",
          ...(this.goalReviewCount === 1
            ? { subjects: goalReviewSubjects() }
            : goalPriorFindingVerdicts(state)),
          ...continuationReviewDecision(state, this.chooseContinuation),
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
        if (this.artifactPlan) {
          const operation = artifactExecutionOperation({
            state,
            checkpointId: envelope.binding.checkpointId,
            operationResultCount: envelope.operationResults.length,
          });
          if (operation) return operation;
        }
        return {
          kind: "result_candidate",
          resultSummary: this.reviewCount === 0 && this.failFirstReview
            ? "고객 응대의 기본 원칙만 초안으로 정리했다"
            : "고객 응대 원칙과 실행 지침을 함께 정리했다",
        };
      case "task_review": {
        if (this.artifactPlan && state.reviewSourceRef && envelope.operationResults.length === 0) {
          return {
            kind: "operation_requests",
            requests: [{
              requestId: `review-validation:${envelope.binding.checkpointId}`,
              publicTitle: "작성된 결과를 검증합니다",
              kind: "review_validation",
              capabilityRef: "harness:validate-artifact",
              reviewSourceRef: state.reviewSourceRef,
              input: { command: "격리 복제본에서 결과를 검증한다" },
            }],
          };
        }
        this.reviewCount += 1;
        const criteria = asArray(state.criteria);
        if (this.failFirstReview && this.reviewCount === this.failedReviewOrdinal) {
          const failedCriterionRef = asRecord(criteria[0]).ref;
          return {
            kind: "task_review",
            criterionVerdicts: criteria.map((criterion, index) => ({
              criterionRef: asRecord(criterion).ref,
              verdict: index === 0 ? "not_satisfied" : "satisfied",
              observation: index === 0
                ? "초안에 실제 적용 지침이 빠져 있다"
                : "해당 기준은 충족한다",
            })),
            findings: [{
              rootCauseKey: "missing-execution-guidance",
              affectedCriterionRefs: [failedCriterionRef],
              findingCategory: this.correctionKind === "implementation_repair"
                ? "implementation_nonconformance"
                : this.correctionKind === "governing_revision"
                  ? "task_decomposition"
                  : "authority_contradiction",
              finding: "수용 기준이 요구한 실행 지침을 구현하지 않았다",
              priority: "P1",
              scopeRelation: "current_task",
              recommendedDisposition: "required_now",
              dispositionRationale: "현재 Task의 명시적 수용 기준을 충족하지 못했다",
              findingOrigin: "initial_review",
            }],
          };
        }
        const priorFindings = asArray(state.priorCorrectionFindings);
        return {
          kind: "task_review",
          criterionVerdicts: criteria.map((criterion) => ({
            criterionRef: asRecord(criterion).ref,
            verdict: "satisfied",
            observation: "원칙과 실행 지침이 모두 포함되어 수용 기준을 충족한다",
          })),
          findings: [],
          ...(priorFindings.length > 0
            ? {
                priorFindingVerdicts: priorFindings.map((finding) => ({
                  rootCauseKey: asRecord(finding).rootCauseKey,
                  verdict: "resolved",
                  observation: "교정 결과가 이 동결 Finding을 해소했다",
                })),
              }
            : {}),
        };
      }
      case "feedback_conception": {
        this.feedbackConceptionCount += 1;
        return {
          kind: "feedback_intent",
          correctionKind: this.reviseFeedbackIntent && this.feedbackConceptionCount > 1
            ? "governing_revision"
            : this.correctionKind,
          intendedCorrection: "누락된 실행 지침만 보완한다",
          ...feedbackFindingDecisions(state, this.reviewFindingDecision),
        };
      }
      case "feedback_planning": {
        const intent = asRecord(asRecord(state.feedbackIntent).feedbackIntent);
        return submitFeedbackPlan(
          state,
          intent.correctionKind as HarnessCorrectionKind,
          this.revalidateAcceptedTask,
          this.reopenArtifactTasks,
        );
      }
      case "feedback_planning_review":
        this.feedbackPlanningReviewCount += 1;
        if (this.reviseFeedbackIntent && this.feedbackPlanningReviewCount === 1) {
          return reviseFeedbackIntentReview();
        }
        return submitFeedbackPlanningReview(
          state,
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

function adopted(assessment: string, adoptedGoalFieldIds: string[]) {
  return { disposition: "adopted", assessment, adoptedGoalFieldIds };
}

function nonApplicable(assessment: string) {
  return { disposition: "non_applicable", assessment, adoptedGoalFieldIds: [] };
}
