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
  };
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
