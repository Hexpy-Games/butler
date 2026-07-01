import { INTERNAL_RECOVERY_REQUIRED_CODE } from "../../../../runtime/internal-recovery-failure.ts";
import {
  appLimitedDeliveryForProjectedFailure,
} from "./app-delivery-projection.ts";
import {
  projectSafeTurnFailure,
  safeTurnFailureEventPayload,
} from "./turn-failure-projection.ts";
import { timestampBefore } from "./app-transport-metadata.ts";
import type { AppTransportProjectionStoreOptions } from "./transport-projection-contract.ts";

export function projectAppTurnFailure(input: {
  options: AppTransportProjectionStoreOptions;
  chatId: string;
  turnId: string;
  message: Record<string, unknown>;
  metadata: Record<string, unknown>;
  eventTimestamp: string;
}): boolean {
  const { options, chatId, turnId, message, metadata, eventTimestamp } = input;
  const turn = options.getTurnRow(turnId);
  if (!turn) return false;
  if (turn.state === "delivered" || turn.state === "cancelled") return false;
  if (
    turn.state === "retrying" &&
    timestampBefore(eventTimestamp, turn.updated_at)
  ) {
    return false;
  }
  const safeError = projectSafeTurnFailure({ message, metadata });
  const mayProjectLimitedFailure =
    turn.state !== "failed" ||
    turn.safe_error_code === INTERNAL_RECOVERY_REQUIRED_CODE ||
    turn.safe_error_code === "inbound_dispatch_timeout";
  const limitedDelivery = mayProjectLimitedFailure
    ? appLimitedDeliveryForProjectedFailure(safeError)
    : null;
  if (limitedDelivery) {
    options.finalizeResponderLimitedDelivery(chatId, turnId, limitedDelivery);
    options.touchChat(chatId);
    void options.drainQueuedSessionMessages(chatId).catch(() => undefined);
    return true;
  }
  const existing = options.getLatestAssistantMessageForTurn(turnId);
  if (
    turn.state === "failed" &&
    turn.safe_error_code === safeError.code &&
    existing?.status === "failed" &&
    existing.safe_error_code === safeError.code &&
    existing.text === safeError.message
  ) {
    return false;
  }

  const runtimeFault = options.runtimeFaultRecordForTurn(turnId);
  const isRuntimeFault = Boolean(runtimeFault);
  const isRetryableRuntimeFault = runtimeFault?.retryable === true;
  options.upsertAssistantTurnFailure(chatId, turnId, safeError, {
    retryable: isRetryableRuntimeFault,
  });
  if (
    !options.hasTurnEventKind(
      turnId,
      isRuntimeFault ? "runtime.fault" : "turn.failed",
    )
  ) {
    options.appendTurnEvent(chatId, turnId, {
      kind: isRuntimeFault ? "runtime.fault" : "turn.failed",
      payload: runtimeFault ?? safeTurnFailureEventPayload(safeError),
    });
  }
  const failedTurn = options.updateTurnState(
    turnId,
    isRuntimeFault ? "runtime_fault" : "failed",
    {
      safeStatusLabel: isRuntimeFault ? "Runtime fault" : "Failed",
      retryable: isRetryableRuntimeFault,
      cancellable: false,
      safeErrorCode: safeError.code,
    },
  );
  options.appendTerminalTurnStateChanged(failedTurn);
  options.touchChat(chatId);
  void options.drainQueuedSessionMessages(chatId).catch(() => undefined);
  return true;
}
