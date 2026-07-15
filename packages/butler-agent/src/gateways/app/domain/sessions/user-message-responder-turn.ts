import {
  completeResponderTurn as completeResponderTurnLifecycle,
} from "./responder-turn-lifecycle.ts";
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
      markResponderNonPublicContinuation: (chatId, turnId, safeErrorCode) =>
        this.input.markResponderNonPublicContinuation(chatId, turnId, safeErrorCode),
      routeResponderRuntimeInterruption: (turnInput, error) =>
        this.input.routeResponderRuntimeInterruption(turnInput, error),
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
    });
  }
}
