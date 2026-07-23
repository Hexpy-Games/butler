import type { BtccTurnProgressObserver } from "../../../agent/btcc/gateway-api.ts";
import type { RuntimeTurnEventInput } from "../../../agent/events/turn-events.ts";

export function projectTurnProgress(
  publish: (event: RuntimeTurnEventInput) => Promise<void>,
): BtccTurnProgressObserver {
  return {
    async stateChanged(update) {
      if (update.semanticState === "delivery_committed") {
        await publish({ kind: "message.final.started" });
        return;
      }
      if (update.semanticState === "delivered") {
        await publish({ kind: "turn.completed" });
        return;
      }
      if (update.semanticState === "cancelled") {
        await publish({ kind: "turn.cancelled" });
        return;
      }
      await publish({
        kind: "assistant.public_note",
        payload: {
          note: progressLabel(update.semanticState),
          btccState: update.semanticState,
          turnRevision: update.turnRevision,
        },
      });
    },
    async operationalNoticeChanged(update) {
      if (update.status === "cleared") return;
      await publish({
        kind: "assistant.public_note",
        payload: {
          note: operationalProgressLabel(update.activationKind),
          operational: true,
          recoveryStatus: update.status,
        },
      });
    },
  };
}

function operationalProgressLabel(
  activation: "automatic_provider_recovery" | "provider_action_required" |
    "automatic_storage_recovery" | "runtime_remediation" | "cancelled" | undefined,
): string {
  if (activation === "automatic_provider_recovery") {
    return "모델 연결을 복구하고 있습니다. 현재 작업은 안전하게 보존되어 있으며 중지할 수 있습니다";
  }
  if (activation === "provider_action_required") {
    return "선택한 모델 연결 설정을 확인하면 저장된 지점부터 이어갈 수 있습니다";
  }
  if (activation === "automatic_storage_recovery") {
    return "저장소 쓰기 순서를 조정하고 있습니다. 현재 작업은 안전하게 보존되어 있으며 중지할 수 있습니다";
  }
  return "현재 작업은 안전하게 보존되어 있으며 중지할 수 있습니다";
}

function progressLabel(state: string): string {
  switch (state) {
    case "admitted": return "요청을 확인하고 있습니다";
    case "conception_opening":
    case "conception_deliberation":
    case "contract_review": return "요청의 의도와 목표를 구상하고 있습니다";
    case "planning":
    case "planning_review": return "작업 계획을 세우고 검토하고 있습니다";
    case "work_frontier": return "다음 작업을 준비하고 있습니다";
    case "task_execution": return "계획한 작업을 수행하고 있습니다";
    case "task_review": return "작업 결과를 검토하고 있습니다";
    case "feedback_conception":
    case "feedback_planning":
    case "feedback_planning_review": return "리뷰 피드백을 반영하고 있습니다";
    case "consolidation": return "전체 목표 달성 여부를 점검하고 있습니다";
    case "reporting": return "최종 답변을 준비하고 있습니다";
    default: return "요청을 처리하고 있습니다";
  }
}
