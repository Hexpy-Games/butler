import {
  projectSafeTurnFailure,
  safeTurnFailureEventPayload,
} from "./turn-failure-projection.ts";
import { timestampBefore } from "./app-transport-metadata.ts";
import type { AppTransportProjectionStoreOptions } from "./transport-projection-contract.ts";
import { btccRetainsTurnAuthority } from "./btcc-turn-projection-authority.ts";
import { runtimeFaultFailureMessage } from "./runtime-fault-failure.ts";
import { safeOptionalShortToken } from "../core/projection-safe-values.ts";
import { projectClaimedOutbound } from "./claimed-outbound-projection.ts";

export function projectAppTurnFailure(input: {
  options: AppTransportProjectionStoreOptions;
  chatId: string;
  turnId: string;
  message: Record<string, unknown>;
  metadata: Record<string, unknown>;
  eventTimestamp: string;
  claimFenceAlreadyHeld?: boolean;
}): boolean {
  const {
    options,
    chatId,
    turnId,
    message,
    metadata,
    eventTimestamp,
    claimFenceAlreadyHeld = false,
  } = input;
  const turn = options.getTurnRow(turnId);
  if (!turn) return false;
  const runtimeFault = options.runtimeFaultRecordForTurn(turnId);
  if (!runtimeFault && btccRetainsTurnAuthority(options.db, turnId)) return false;
  if (turn.state === "delivered" || turn.state === "cancelled") {
    const settled = projectClaimedOutbound(options, {
      chatId,
      turnId,
      metadata,
      claimFenceAlreadyHeld,
    }, () =>
      settleQueuedTurn(options, chatId, turnId, metadata,
        existingAssistantMessageId(options, turnId),
        turn.state === "cancelled" ? "turn_cancelled" : undefined),
    );
    if (!settled && queuedSettlementRequired(options, chatId, turnId, metadata)) {
      return false;
    }
    if (settled) void options.drainQueuedSessionMessages(chatId).catch(() => undefined);
    return true;
  }
  if (
    turn.state === "retrying" &&
    timestampBefore(eventTimestamp, turn.updated_at)
  ) {
    return false;
  }
  const safeError = projectSafeTurnFailure({ message, metadata });
  const existing = options.getLatestAssistantMessageForTurn(turnId);
  if (
    turn.state === "failed" &&
    turn.safe_error_code === safeError.code &&
    existing?.status === "failed" &&
    existing.safe_error_code === safeError.code &&
    existing.text === safeError.message
  ) {
    const settled = projectClaimedOutbound(
      options,
      { chatId, turnId, metadata, claimFenceAlreadyHeld },
      () => settleQueuedTurn(options, chatId, turnId, metadata, existing.id, safeError.code),
    );
    if (!settled && queuedSettlementRequired(options, chatId, turnId, metadata)) {
      return false;
    }
    if (settled) void options.drainQueuedSessionMessages(chatId).catch(() => undefined);
    return true;
  }

  let settledForDrain = false;
  const projected = projectClaimedOutbound(options, {
    chatId,
    turnId,
    metadata,
    claimFenceAlreadyHeld,
  }, () => {
    const isRuntimeFault = Boolean(runtimeFault);
    const isRetryableRuntimeFault = runtimeFault?.retryable === true;
    const projectedError = runtimeFaultFailureMessage(runtimeFault, safeError);
    const failureMessage = options.upsertAssistantTurnFailure(chatId, turnId, projectedError, {
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
        payload: runtimeFault ?? safeTurnFailureEventPayload(projectedError),
      });
    }
    const failedTurn = options.updateTurnState(
      turnId,
      isRuntimeFault ? "runtime_fault" : "failed",
      {
        safeStatusLabel: isRuntimeFault ? "Runtime fault" : "Failed",
        retryable: isRetryableRuntimeFault,
        cancellable: false,
        safeErrorCode: projectedError.code,
      },
    );
    options.appendTerminalTurnStateChanged(failedTurn);
    const settled = settleQueuedTurn(
      options,
      chatId,
      turnId,
      metadata,
      failureMessage.id,
      projectedError.code,
    );
    if (!settled && queuedSettlementRequired(options, chatId, turnId, metadata)) {
      return false;
    }
    options.touchChat(chatId);
    settledForDrain = settled;
    return true;
  });
  if (!projected) return false;
  if (settledForDrain) void options.drainQueuedSessionMessages(chatId).catch(() => undefined);
  return true;
}

function existingAssistantMessageId(
  options: AppTransportProjectionStoreOptions,
  turnId: string,
): string | undefined {
  return options.getLatestAssistantMessageForTurn(turnId)?.id;
}

function settleQueuedTurn(
  options: AppTransportProjectionStoreOptions,
  chatId: string,
  turnId: string,
  metadata: Record<string, unknown>,
  resultMessageId?: string,
  safeErrorCode?: string,
): boolean {
  const claimId = safeOptionalShortToken(metadata.appQueueClaimId);
  if (!claimId) return false;
  return options.acknowledgeQueuedMessageForTurn({
    chatId,
    turnId,
    claimId,
    ...(resultMessageId ? { resultMessageId } : {}),
    ...(safeErrorCode ? { safeErrorCode } : {}),
  });
}

function queuedSettlementRequired(
  options: AppTransportProjectionStoreOptions,
  chatId: string,
  turnId: string,
  metadata: Record<string, unknown>,
): boolean {
  return options.queuedTurnClaimStatus(
    chatId,
    turnId,
    safeOptionalShortToken(metadata.appQueueClaimId),
  ) !== "unlinked";
}
