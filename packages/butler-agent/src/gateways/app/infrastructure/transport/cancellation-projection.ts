import type { TranscriptEvent } from
  "../../../../test-support/harness/transcripts.ts";
import type { AppTransportProjectionStoreOptions } from
  "./transport-projection-contract.ts";
import {
  safeOptionalShortToken,
} from "../core/projection-safe-values.ts";
import { projectClaimedOutbound } from "./claimed-outbound-projection.ts";

export function projectAppCancellationAck(input: {
  options: AppTransportProjectionStoreOptions;
  chatId: string;
  turnId: string;
  actionId: string;
  event: TranscriptEvent;
  metadata: Record<string, unknown>;
  deliveryState: "pending" | "delivered";
  stage: () => void;
  markProjected: () => void;
}): boolean | null {
  if (input.metadata.kind !== "turn_cancellation_ack") return null;
  return projectClaimedOutbound(
    input.options,
    {
      chatId: input.chatId,
      turnId: input.turnId,
      metadata: input.metadata,
    },
    () => {
      if (input.deliveryState !== "delivered") {
        input.stage();
        return false;
      }
      input.options.db.query(`
        UPDATE app_turn_cancel_outbox
        SET state = 'accepted', queue_id = ?, dispatch_claim_id = ?,
          accepted_at = ?, safe_error_code = NULL
        WHERE turn_id = ? AND state = 'pending'
      `).run(
        safeOptionalShortToken(input.metadata.queueId) ?? null,
        safeOptionalShortToken(input.metadata.dispatchClaimId) ?? null,
        input.event.timestamp,
        input.turnId,
      );
      input.markProjected();
      return true;
    },
  );
}

export function projectAppCancellationTerminal(input: {
  options: AppTransportProjectionStoreOptions;
  chatId: string;
  turnId: string;
  timestamp: string;
  metadata: Record<string, unknown>;
  claimFenceAlreadyHeld?: boolean;
}): boolean {
  const claimId = typeof input.metadata.appQueueClaimId === "string"
    ? input.metadata.appQueueClaimId.trim()
    : "";
  return projectClaimedOutbound(
    input.options,
    {
      chatId: input.chatId,
      turnId: input.turnId,
      metadata: input.metadata,
      claimFenceAlreadyHeld: input.claimFenceAlreadyHeld,
    },
    () => {
    const current = input.options.getTurnRow(input.turnId);
    if (!current) return false;
    if (current.state !== "cancelled") {
      input.options.db.query(`
        UPDATE app_turn_cancel_outbox
        SET state = 'completed', accepted_at = COALESCE(accepted_at, ?),
          completed_at = ?, safe_error_code = NULL
        WHERE turn_id = ? AND state IN ('pending', 'accepted')
      `).run(input.timestamp, input.timestamp, input.turnId);
      input.options.finalizeCancelledTurn(input.chatId, input.turnId);
    }
    if (!claimId) return true;
    const settled = input.options.acknowledgeQueuedMessageForTurn({
      chatId: input.chatId,
      turnId: input.turnId,
      claimId,
      safeErrorCode: "turn_cancelled",
      resultMessageId: input.options.getLatestAssistantMessageForTurn(input.turnId)?.id,
    });
    return settled || input.options.queuedTurnClaimStatus(
      input.chatId,
      input.turnId,
      claimId,
    ) === "unlinked";
    },
  );
}
