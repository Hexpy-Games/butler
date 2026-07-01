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
      finalizeResponderLimitedDelivery: (chatId, turnId, limitedDelivery) =>
        this.input.finalizeResponderLimitedDelivery(
          chatId,
          turnId,
          limitedDelivery,
        ),
      markResponderNonPublicContinuation: (chatId, turnId) =>
        this.input.markResponderNonPublicContinuation(chatId, turnId),
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
      touchChat: (chatId) => this.input.touchChat(chatId),
      updateTurnDelivered: (turnId, delivery) => {
        const limitedDelivery =
          delivery?.delivery_state === "delivered_with_limitations";
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
    this.input.upsertAssistantTurnFailure(chatId, turnId, safeError, {
      retryable: isRetryableRuntimeFault,
    });
    const failureKind = isRuntimeFault ? "runtime.fault" : "turn.failed";
    if (!this.input.hasTurnEventKind(turnId, failureKind)) {
      this.input.appendTurnEvent(chatId, turnId, {
        kind: failureKind,
        payload: runtimeFault ?? safeTurnFailureEventPayload(safeError),
      });
    }
    const failedTurn = this.input.updateTurnState(
      turnId,
      isRuntimeFault ? "runtime_fault" : "failed",
      {
        safeStatusLabel: isRuntimeFault ? "Runtime fault" : "Failed",
        retryable: isRetryableRuntimeFault,
        cancellable: false,
        safeErrorCode: safeError.code,
      },
    );
    this.input.appendTerminalTurnStateChanged(failedTurn);
    return failedTurn;
  }
}
