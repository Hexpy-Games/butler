import type { BtccTurnProgressObserver } from "../contracts.ts";
import type { RuntimeTurnEventInput } from "../../events/turn-events.ts";
import { publicOperationTitle } from "../../events/progress-projection.ts";

export async function publishOperationalNotice(
  observer: BtccTurnProgressObserver | undefined,
  update: Parameters<NonNullable<
    BtccTurnProgressObserver["operationalNoticeChanged"]
  >>[0],
): Promise<void> {
  if (!observer?.operationalNoticeChanged) return;
  try {
    await observer.operationalNoticeChanged(update);
  } catch {
    // Public progress cannot veto durable Turn state.
  }
}

/** Converts durable Turn progress into the conversation/event vocabulary. */
export function projectTurnProgressToEvents(
  publish: (event: RuntimeTurnEventInput) => Promise<void> | void,
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
            ...(update.modelRef
              ? { model: update.modelRef, modelRef: update.modelRef }
              : {}),
            detailRows: [{
              id: "work",
              kind: "work",
              safe_label: "Work",
              safe_value: task.workTitle,
              state: task.workState,
            }, {
              id: "task-description",
              kind: "task_description",
              safe_label: "Task",
              safe_value: task.taskDescription,
              state: task.taskState,
            }, {
              id: "task-outcome",
              kind: "task_outcome",
              safe_label: "Task outcome",
              safe_value: task.taskOutcome,
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
          decisionTitle: update.title,
          decisionSummary: update.summary,
          ...(update.rationale !== undefined
            ? { decisionRationale: update.rationale }
            : {}),
          ...(update.nextStep !== undefined
            ? { decisionNextStep: update.nextStep }
            : {}),
          decisionSource: "model-authored",
          semanticBlockId: update.activityId,
          ...(update.displayStage !== undefined
            ? { activityStage: update.displayStage }
            : {}),
          ...(update.modelRef ? { model: update.modelRef } : {}),
        },
      });
    },
    async operationChanged(update) {
      await publish({
        kind: operationEventKind(update.status),
        payload: {
          safeLabel: update.publicTitle || publicOperationTitle(update.capabilityRef),
          toolName: update.capabilityRef,
          toolCallId: update.requestId,
          activityKind: "used_tool",
          bridgePhase: "btcc_operation",
          semanticBlockId: update.activityId,
          operationStatus: update.status,
          ...(update.inputLabel !== undefined
            ? { inputLabel: update.inputLabel }
            : {}),
          ...(update.detailRows !== undefined
            ? { detailRows: update.detailRows }
            : {}),
          ...(update.resultRef ? { resultId: update.resultRef.id } : {}),
          ...(update.byteLength !== undefined
            ? { resultByteLength: update.byteLength }
            : {}),
        },
      });
    },
    async modelRoundWaitingChanged(update) {
      if (update.status === "started" && update.modelRef) {
        try {
          await publish({
            kind: "turn.iteration.started",
            payload: {
              model: update.modelRef,
              modelRef: update.modelRef,
              requestId: update.requestId,
            },
          });
        } catch {
          // Public model identity is observational; it cannot veto dispatch.
        }
      }
      await publish({
        kind: modelRoundWaitingEventKind(update.status),
        payload: {
          safeLabel: "응답 생성 중",
          toolName: "model_round",
          toolCallId: update.requestId,
          activityKind: "message",
          bridgePhase: "model_round_waiting",
          ...(update.modelRef ? { model: update.modelRef, modelRef: update.modelRef } : {}),
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

function modelRoundWaitingEventKind(
  status: "started" | "completed" | "failed" | "cancelled",
): "tool.started" | "tool.completed" | "tool.failed" | "tool.cancelled" {
  if (status === "started") return "tool.started";
  if (status === "completed") return "tool.completed";
  if (status === "cancelled") return "tool.cancelled";
  return "tool.failed";
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
  activation: "automatic_storage_recovery" | "cancelled" | undefined,
  _code?: string,
): string {
  if (activation === "automatic_storage_recovery") {
    return "저장소 쓰기 순서를 조정하고 있습니다";
  }
  return "요청을 중지하고 있습니다";
}

function progressLabel(state: string): string {
  switch (state) {
    case "admitted": return "요청을 확인하고 있습니다";
    default: return "요청을 처리하고 있습니다";
  }
}
