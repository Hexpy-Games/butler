import type { BtccRuntimeDependencies } from "../../agent/btcc/index.ts";

type SelectedModel = BtccRuntimeDependencies["model"];
type PhaseEnvelope = Parameters<SelectedModel["runRound"]>[0];
type ProviderRoundValue = Awaited<ReturnType<SelectedModel["runRound"]>>;

export class ManagedHarnessModel implements SelectedModel {
  callCount = 0;
  readonly phases: string[] = [];
  private reviewCount = 0;
  private planningReviewCount = 0;
  private feedbackPlanningReviewCount = 0;

  constructor(
    private readonly failFirstReview: boolean,
    private readonly reviseFirstPlan = false,
    private readonly reviseFirstCorrection = false,
  ) {}

  async runRound(envelope: PhaseEnvelope): Promise<ProviderRoundValue> {
    this.callCount += 1;
    this.phases.push(envelope.phase);
    return {
      kind: "phase_submission",
      submission: this.submissionFor(envelope),
      actualIdentity: {
        provider: envelope.modelSelection.provider,
        model: envelope.modelSelection.model,
        reasoningEffort: envelope.modelSelection.reasoningEffort,
        controlsHash: envelope.modelSelection.controlsHash,
      },
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
        const personalizationRefs = [
          ...envelope.context.profileRefs,
          ...envelope.context.recentFeedbackRefs,
          ...envelope.context.mandatoryHotCacheRefs,
          ...envelope.context.optionalHotCacheRefs,
        ];
        return {
          kind: "goal_contract_candidate",
          request: "고객 응대 원칙을 조사한다",
          intendedResult: "짧고 실행 가능한 운영 가이드를 제공한다",
          acceptanceIntent: "원래 요청을 빠뜨리지 않은 운영 가이드가 완성된다",
          nonGoals: ["프로젝트 파일이나 외부 시스템을 변경하지 않는다"],
          personalizationRefs,
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
        return {
          kind: "goal_contract_review",
          candidateRef: nestedRef(state, "goalCandidate", "candidate"),
          strategy: "managed",
          reviewedLensIds: [
            "requested_content", "related_memory", "connected_current_knowledge",
            "user_preferences_and_resolution_style", "expert_perspective",
            "intended_result_and_acceptance",
          ],
          reviewedFieldIds: ["request", "intended_result"],
          reviewedOutcomeIds: [nestedValue(
            state,
            "goalCandidate", "candidate", "proposedContract", "requiredOutcome", "outcomeId",
          )],
          verdict: "accepted",
        };
      case "planning":
        return {
          kind: "plan_candidate",
          strategy: "조사와 가이드 완성을 독립적으로 검토 가능한 두 Task로 구성한다",
          works: [{
            logicalId: "customer-service-guide",
            outcome: "고객 응대 운영 가이드 완성",
            dependencyWorkIds: [],
            tasks: [
              {
                logicalId: "research-principles",
                intendedOutcome: "고객 응대 핵심 원칙을 조사하고 정리",
                executionOrdinal: 1,
                dependencyTaskIds: [],
                targetScopeRefs: ["session:managed-guide"],
                criteria: [{
                  statement: "요청한 고객 응대 원칙이 조사 결과에 포함된다",
                  question: "조사 결과가 원래 요청의 핵심 원칙을 충족하는가?",
                  sourceGoalFieldIds: ["request"],
                  sourceRequiredOutcomeRefs: [state.requiredOutcomeId],
                }],
              },
              {
                logicalId: "write-guide",
                intendedOutcome: "조사 결과를 짧고 실행 가능한 가이드로 작성",
                executionOrdinal: 2,
                dependencyTaskIds: ["research-principles"],
                targetScopeRefs: ["session:managed-guide"],
                criteria: [{
                  statement: "가이드가 짧고 실행 가능한 적용 지침을 제공한다",
                  question: "최종 가이드가 의도한 결과와 완료 조건을 충족하는가?",
                  sourceGoalFieldIds: ["intended_result"],
                  sourceRequiredOutcomeRefs: [state.requiredOutcomeId],
                }],
              },
            ],
          }],
        };
      case "planning_review":
        this.planningReviewCount += 1;
        return {
          kind: "planning_review",
          candidateRef: nestedRef(state, "planCandidate", "candidate"),
          reviewedBundleRef: nestedValue(state, "planCandidate", "candidate", "bundle", "ref"),
          reviewedWorkGraphRef: nestedValue(
            state, "planCandidate", "candidate", "workGraph", "ref",
          ),
          reviewedWorkRefs: nestedRecords(state, "works"),
          reviewedTaskRefs: nestedRecords(state, "tasks"),
          reviewedCriterionRefs: nestedRecords(state, "criteria"),
          reviewedVerificationQuestionRefs: nestedRecords(state, "verificationQuestions"),
          reviewedArtifactLifecycleRef: nestedValue(
            state, "planCandidate", "candidate", "artifactLifecycle", "ref",
          ),
          reviewedGoalFieldIds: ["request", "intended_result"],
          reviewedRequiredOutcomeRefs: [firstCriterionOutcome(state)],
          verdict: this.reviseFirstPlan && this.planningReviewCount === 1
            ? "revision_required"
            : "accepted",
          findings: this.reviseFirstPlan && this.planningReviewCount === 1
            ? ["두 번째 Task의 완료 조건을 더 명확히 표현해야 한다"]
            : [],
        };
      case "task_execution":
        return {
          kind: "result_candidate",
          resultSummary: this.reviewCount === 0 && this.failFirstReview
            ? "고객 응대의 기본 원칙만 초안으로 정리했다"
            : "고객 응대 원칙과 실행 지침을 함께 정리했다",
          observedState: "요청 범위에 맞는 운영 가이드 본문이 존재한다",
        };
      case "task_review": {
        this.reviewCount += 1;
        const resultCandidateRef = nestedRef(state, "resultCandidate", "result");
        if (this.failFirstReview && this.reviewCount === 1) {
          return {
            kind: "task_review",
            resultCandidateRef,
            verdict: "not_passed",
            observation: "초안에 실제 적용 지침이 빠져 있다",
            finding: "수용 기준이 요구한 실행 지침을 구현하지 않았다",
          };
        }
        return {
          kind: "task_review",
          resultCandidateRef,
          verdict: "passed",
          observation: "원칙과 실행 지침이 모두 포함되어 수용 기준을 충족한다",
        };
      }
      case "feedback_conception":
        return {
          kind: "feedback_intent",
          correctionKind: "implementation_repair",
          intendedCorrection: "누락된 실행 지침만 보완한다",
        };
      case "feedback_planning":
        return {
          kind: "feedback_plan_candidate",
          correctionKind: "implementation_repair",
          correctionAction: "같은 Task에서 고객 응대 원칙별 실행 지침을 추가한다",
        };
      case "feedback_planning_review":
        this.feedbackPlanningReviewCount += 1;
        return {
          kind: "feedback_planning_review",
          candidateRef: nestedRef(state, "feedbackPlan", "candidate"),
          correctionKind: "implementation_repair",
          verdict: this.reviseFirstCorrection && this.feedbackPlanningReviewCount === 1
            ? "revision_required"
            : "accepted",
          findings: this.reviseFirstCorrection && this.feedbackPlanningReviewCount === 1
            ? ["보완 행동을 실패한 Task 범위로 더 명확히 제한해야 한다"]
            : [],
        };
      case "consolidation":
        return {
          kind: "final_dossier",
          originalGoalContractRef: state.goalContractRef,
          goalCoverage: "fulfilled",
          semanticFidelity: "faithful",
          summary: "원래 요청에 맞는 고객 응대 운영 가이드가 완성되었다",
        };
      case "reporting":
        return {
          kind: "prepared_report",
          finalDossierRef: nestedRef(state, "finalDossier", "dossier"),
          guardVerdict: "accepted",
          content: "고객 응대 운영 가이드를 완성했습니다. 핵심은 경청, 명확한 확인, 실행 가능한 안내, 후속 확인입니다.",
        };
    }
  }
}

function nestedRecords(state: Record<string, unknown>, key: string): unknown[] {
  const records = nestedValue(state, "planCandidate", "candidate", key);
  if (!Array.isArray(records)) return [];
  return records.map((record) => asRecord(record).ref);
}

function firstCriterionOutcome(state: Record<string, unknown>): unknown {
  const criteria = nestedValue(state, "planCandidate", "candidate", "criteria");
  if (!Array.isArray(criteria)) return undefined;
  const refs = asRecord(criteria[0]).sourceRequiredOutcomeRefs;
  return Array.isArray(refs) ? refs[0] : undefined;
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
