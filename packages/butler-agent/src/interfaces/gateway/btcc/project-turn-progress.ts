import type { BtccTurnProgressObserver } from "../../../agent/btcc/gateway-api.ts";
import type { RuntimeTurnEventInput } from "../../../agent/events/turn-events.ts";
import { publicOperationTitle } from "../../../agent/events/progress-projection.ts";

export function projectTurnProgress(
  publish: (event: RuntimeTurnEventInput) => Promise<void>,
): BtccTurnProgressObserver {
  return {
    async openingDecisionAccepted(update) {
      await publish({
        kind: "assistant.decision",
        payload: {
          decisionId: update.decisionId,
          role: "opening",
          summary: update.summary,
          rationale: update.rationale,
          nextStep: update.nextStep,
          source: "model-authored",
          firstVisible: true,
          turnRevision: update.turnRevision,
        },
      });
    },
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
          semanticBlockId: update.semanticState,
          turnRevision: update.turnRevision,
        },
      });
    },
    async workProgressChanged(update) {
      for (const task of update.tasks) {
        await publish({
          kind: "tool.progress",
          payload: {
            activityKind: "todo",
            todoId: task.taskId,
            safeLabel: task.taskTitle,
            state: task.taskState,
            safeOrder: task.taskOrder,
            bridgePhase: "btcc_work_ledger",
            workstreamId: task.workId,
            semanticBlockId: `work-ledger-${update.programId}`,
            turnRevision: update.turnRevision,
            detailRows: [{
              id: "work",
              kind: "work",
              safe_label: "Work",
              safe_value: task.workTitle,
              state: task.workState,
            }],
          },
        });
      }
    },
    async phaseActivityChanged(update) {
      await publish({
        kind: "assistant.public_note",
        payload: {
          note: update.summary,
          btccState: update.semanticState,
          decisionSummary: update.summary,
          decisionRationale: update.rationale,
          decisionNextStep: update.nextStep,
          decisionSource: "model-authored",
          semanticBlockId: update.semanticState,
        },
      });
    },
    async modelRoundWaiting(update) {
      await publish({
        kind: "assistant.public_note",
        payload: {
          note: "모델 응답을 기다리고 있습니다",
          btccState: update.semanticState,
          semanticBlockId: update.semanticState,
          bridgePhase: "model_round_waiting",
          checkpointId: update.checkpointId,
        },
      });
    },
    async operationChanged(update) {
      await publish({
        kind: operationEventKind(update.status),
        payload: {
          safeLabel: publicOperationTitle(update.capabilityRef),
          toolName: update.capabilityRef,
          toolCallId: update.requestId,
          activityKind: "used_tool",
          bridgePhase: "btcc_operation",
          semanticBlockId: update.semanticState,
          operationStatus: update.status,
          ...(update.resultRef ? { resultId: update.resultRef.id } : {}),
          ...(update.byteLength !== undefined
            ? { resultByteLength: update.byteLength }
            : {}),
        },
      });
    },
    async operationalNoticeChanged(update) {
      if (update.status === "cleared") {
        await publish({
          kind: "assistant.public_note",
          payload: {
            note: progressLabel(update.semanticState),
            btccState: update.semanticState,
            semanticBlockId: update.semanticState,
            bridgePhase: "operational_recovery",
            recoveryStatus: update.status,
          },
        });
        return;
      }
      await publish({
        kind: "assistant.public_note",
        payload: {
          note: operationalProgressLabel(update.activationKind, update.code),
          btccState: update.semanticState,
          operational: true,
          semanticBlockId: update.semanticState,
          bridgePhase: "operational_recovery",
          recoveryStatus: update.status,
        },
      });
    },
  };
}

function operationEventKind(
  status: "started" | "completed" | "failed" | "cancelled",
): "tool.started" | "tool.completed" | "tool.failed" | "tool.cancelled" {
  if (status === "started") return "tool.started";
  if (status === "completed") return "tool.completed";
  if (status === "cancelled") return "tool.cancelled";
  return "tool.failed";
}

function operationalProgressLabel(
  activation: "automatic_provider_recovery" | "provider_action_required" |
    "automatic_storage_recovery" | "runtime_remediation" | "cancelled" | undefined,
  code?: string,
): string {
  if (activation === "runtime_remediation") {
    return "현재 작업을 저장된 지점에 안전하게 보류했습니다. 중지 기능은 계속 사용할 수 있습니다";
  }
  if (activation === "automatic_provider_recovery" &&
    (code === "provider_phase_submission_invalid" ||
      code === "provider_protocol_interruption")) {
    return "모델 출력 계약을 바로잡고 있습니다. 완료된 작업은 그대로 보존됩니다";
  }
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
    case "assisted_answer":
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
