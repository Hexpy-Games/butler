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
      summary: "사용자 승인이 필요해 현재 결과와 열린 작업을 보존했다",
    };
  }
  if (asArray(state.promotionAssemblies).length > 0) {
    return {
      kind: "promotion_authorization",
      ...assessment,
      goalCoverage: "fulfilled",
      semanticFidelity: "faithful",
    };
  }
  return {
    kind: "final_dossier",
    ...assessment,
    goalCoverage: "fulfilled",
    semanticFidelity: "faithful",
    summary: "원래 요청에 맞는 고객 응대 운영 가이드가 완성되었다",
  };
}

function assessmentVerdicts(state: Record<string, unknown>, repair: boolean) {
  return {
    goalFieldVerdicts: asArray(state.goalFields).map((field, index) => ({
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
  return {
    kind: "prepared_report",
    content: dossier.disposition === "deferred"
      ? "현재까지의 결과를 보존했습니다. 다음 작업에는 사용자 승인이 필요합니다."
      : "고객 응대 운영 가이드를 완성했습니다. 핵심은 경청, 명확한 확인, 실행 가능한 안내, 후속 확인입니다.",
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
