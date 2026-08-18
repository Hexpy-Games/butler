import {
  completeResponderTurn as completeResponderTurnLifecycle,
} from "./responder-turn-lifecycle.ts";
import { safeTurnFailureEventPayload } from "../../infrastructure/transport/turn-failure-projection.ts";
import type {
  MessageRecord,
  TurnRecord,
} from "../../interface/protocol/app-protocol.ts";
import type {
  UserMessageTurnStoreInput,
  UserResponderTurnInput,
} from "./user-message-turn-contract.ts";
import { runtimeFaultFailureMessage } from
  "../../infrastructure/transport/runtime-fault-failure.ts";

export class AppUserMessageResponderTurn {
  constructor(private readonly input: UserMessageTurnStoreInput) {}

  async complete(input: UserResponderTurnInput): Promise<{
    reply?: MessageRecord;
    replies: MessageRecord[];
    turn: TurnRecord;
    next_cursor: number;
  }> {
    return await completeResponderTurnLifecycle(input, {
      appendProgress: (row) =>
        this.input.appendProgressSummaryEvent(input.chatId, input.turnId, row),
      appendTurnEvent: (event) =>
        this.input.appendTurnEvent(input.chatId, input.turnId, event),
      cleanupTurnEventSequences: (chatId, turnId) =>
        this.input.cleanupTurnEventSequences(chatId, turnId),
      createResponderMessageFiles: (chatId, files) =>
        this.input.createResponderMessageFiles(chatId, files ?? []),
      drainQueuedSessionMessages: (chatId, responder, options) =>
        this.input.drainQueuedSessionMessages(chatId, responder, options),
      finalizeCancelledTurn: (chatId, turnId) =>
        this.input.finalizeCancelledTurn(chatId, turnId),
      hasTurnEventKind: (turnId, kind) =>
        this.input.hasTurnEventKind(turnId, kind),
      insertOrReplaceAssistantReplies: (chatId, turnId, texts, files) =>
        this.input.insertOrReplaceAssistantReplies(
          chatId,
          turnId,
          texts,
          files,
        ),
      runResponder: (
        chatId,
        turnId,
        messageId,
        text,
        responder,
        options,
        onProgress,
        onTurnEvent,
      ) =>
        this.input.runResponder(
          chatId,
          turnId,
          messageId,
          text,
          responder,
          options,
          onProgress,
          onTurnEvent,
        ),
      assertQueueClaim: input.queuedMessageId && input.queueClaimId
        ? () => {
          if (!this.input.assertQueuedMessageClaim(
            input.chatId,
            input.queuedMessageId!,
            input.queueClaimId!,
          )) throw new Error("queued_message_claim_lost");
        }
        : undefined,
      touchChat: (chatId) => this.input.touchChat(chatId),
      updateTurnDelivered: (turnId, delivery) => {
        const limitedDelivery =
          delivery?.delivery_state === "delivered_with_limitations" ||
          delivery?.delivery_state === "delivered_with_continuation";
        const deliveredTurn = this.input.updateTurnState(turnId, "delivered", {
          safeStatusLabel: limitedDelivery
            ? "Delivered with limitations"
            : "Delivered",
          retryable: false,
          cancellable: false,
          safeErrorCode: null,
        });
        this.input.appendTerminalTurnStateChanged(deliveredTurn);
        return deliveredTurn;
      },
      updateTurnFailed: (chatId, turnId, safeError) =>
        this.updateTurnFailed(chatId, turnId, safeError),
      runInTransaction: <T>(callback: () => T) => this.input.runInTransaction(callback),
      fenceQueuedTurnClaim: (claim) => this.input.fenceQueuedTurnClaim(claim),
      acknowledgeQueuedMessageForTurn: (claim) =>
        this.input.acknowledgeQueuedMessageForTurn(claim),
      terminalResultMessageIdForTurn: (chatId, turnId) =>
        this.input.terminalResultMessageIdForTurn(chatId, turnId),
    });
  }

  private updateTurnFailed(
    chatId: string,
    turnId: string,
    safeError: { code: string; message: string },
  ): TurnRecord {
    const runtimeFault = this.input.runtimeFaultRecordForTurn(turnId);
    const isRuntimeFault = Boolean(runtimeFault);
    const isRetryableRuntimeFault = runtimeFault?.retryable === true;
    const projectedError = runtimeFaultFailureMessage(runtimeFault, safeError);
    this.input.upsertAssistantTurnFailure(chatId, turnId, projectedError, {
      retryable: isRetryableRuntimeFault,
    });
    const failureKind = isRuntimeFault ? "runtime.fault" : "turn.failed";
    if (!this.input.hasTurnEventKind(turnId, failureKind)) {
      this.input.appendTurnEvent(chatId, turnId, {
        kind: failureKind,
          payload: runtimeFault ?? safeTurnFailureEventPayload(projectedError),
      });
    }
    const failedTurn = this.input.updateTurnState(
      turnId,
      isRuntimeFault ? "runtime_fault" : "failed",
      {
        safeStatusLabel: isRuntimeFault ? "Runtime fault" : "Failed",
        retryable: isRetryableRuntimeFault,
        cancellable: false,
        safeErrorCode: projectedError.code,
      },
    );
    this.input.appendTerminalTurnStateChanged(failedTurn);
    return failedTurn;
  }
}
