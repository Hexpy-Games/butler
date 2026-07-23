export function submitConsolidation(
  state: Record<string, unknown>,
  requireRepair: boolean,
): unknown {
  const assessment = assessmentVerdicts(state, requireRepair);
  if (requireRepair) {
    return {
      kind: "consolidation_repair",
      ...assessment,
      findings: ["개별 Task는 통과했지만 전체 운영 가이드의 적용 순서가 빠져 있다"],
      affectedTaskIds: asArray(state.taskRefs).map((ref) => String(asRecord(ref).id)),
    };
  }
  if (state.sourceDeferral) {
    return {
      kind: "final_dossier",
      goalCoverage: "deferred",
      semanticFidelity: "faithful",
      userReport: deferredReportFacts(),
    };
  }
  return {
    kind: "final_dossier",
    ...assessment,
    goalCoverage: "fulfilled",
    semanticFidelity: "faithful",
    userReport: state.promotionClosure === "promoted"
      ? promotedReportFacts() : completedReportFacts(),
  };
}

function assessmentVerdicts(state: Record<string, unknown>, repair: boolean) {
  return {
    goalFieldVerdicts: asArray(state.goalFields).map((field, index) => ({
      fieldId: String(asRecord(field).fieldId),
      verdict: repair && index === 1 ? "not_fulfilled" : "fulfilled",
    })),
    taskCompatibility: {
      verdict: "compatible",
    },
    semanticFidelity: "faithful",
  };
}

export function submitReport(state: Record<string, unknown>): unknown {
  const dossier = asRecord(asRecord(state.finalDossier).dossier);
  const report = asRecord(dossier.userReport);
  const changes = asArray(report.materialChanges).map(String).join("\n- ");
  const validation = asArray(report.validationResults).map(String).join("\n- ");
  return {
    kind: "prepared_report",
    content: dossier.disposition === "deferred"
      ? "현재까지의 결과를 보존했습니다. 다음 작업에는 사용자 승인이 필요합니다."
      : `${String(report.outcome)}\n\n변경:\n- ${changes}\n\n검증:\n- ${validation}`,
  };
}

function completedReportFacts() {
  return {
    outcome: "고객 응대 운영 가이드를 완성했다",
    materialChanges: ["경청, 명확한 확인, 실행 가능한 안내, 후속 확인 원칙을 정리했다"],
    validationResults: ["모든 Task Review가 수용 기준을 통과했다"],
    limitations: [],
  };
}

function promotedReportFacts() {
  return {
    outcome: "고객 응대 운영 가이드를 원본에 반영했다",
    materialChanges: ["검토된 격리 결과를 승인된 대상에 정확히 반영했다"],
    validationResults: ["프로모션 동일성 Review를 포함한 모든 Task Review가 통과했다"],
    limitations: [],
  };
}

function deferredReportFacts() {
  return {
    outcome: "현재까지 완료된 결과를 보존했다",
    materialChanges: ["완료된 작업과 이어서 수행할 작업 경계를 기록했다"],
    validationResults: ["완료된 Task Review만 최종 기록에 포함했다"],
    limitations: ["다음 단계에는 사용자의 명시적 승인이 필요하다"],
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
