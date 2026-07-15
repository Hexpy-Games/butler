import {
  appLimitedDeliveryForError,
  appNonPublicContinuationSafeErrorCode,
  appSafeResponderError,
  isNonPublicContinuationDeliveryError,
} from "../../infrastructure/transport/failure-ux-contract.ts";
import { messageFromRow } from "./message-read-model.ts";
import type {
  MessageRecord,
  MessageSendResult,
  TurnRecord,
} from "../../interface/protocol/app-protocol.ts";
import type {
  AppMessageResponder,
  SendMessageOptions,
} from "./message-responder-contract.ts";
import { isResponderCancelError } from "./responder-turn-lifecycle.ts";
import {
  AppSystemResponderCompletionProjector,
  systemAcceptedMessage,
} from "./system-responder-completion.ts";
import { isResponderRuntimeInterruption } from "./responder-runtime-interruption.ts";
import type {
  SystemResponderCompletionInput,
  SystemResponderTurnStoreInput,
} from "./system-responder-turn-contract.ts";

export class AppSystemResponderTurnStore {
  private readonly pendingTurns = new Set<string>();
  private readonly completion: AppSystemResponderCompletionProjector;

  constructor(private readonly input: SystemResponderTurnStoreInput) {
    this.completion = new AppSystemResponderCompletionProjector(input);
  }

  async run(
    chatId: string,
    messageId: string,
    text: string,
    responder: AppMessageResponder,
    options: SendMessageOptions = {},
  ): Promise<MessageSendResult> {
    this.input.ensureChat(chatId);
    const controls = this.input.getSessionControls(chatId);
    const turn = this.input.insertTurn(chatId, "accepted", "Accepted");
    this.input.appendTurnAcknowledgedEvent(chatId, turn.id);
    const thinkingTurn = this.input.updateTurnState(turn.id, "thinking", {
      safeStatusLabel: "Thinking",
      cancellable: true,
    });
    this.input.appendEvent("turn.state_changed", { turn: thinkingTurn });

    try {
      return await this.complete({
        chatId,
        messageId,
        text,
        responder,
        options: { ...options, controls },
        turn,
      });
    } catch (error) {
      return this.handleError({ chatId, messageId, turn, error });
    } finally {
      this.input.cleanupTurnEventSequences(chatId, turn.id);
    }
  }

  schedule(input: {
    key: string;
    chatId: string;
    text: string;
    responder: AppMessageResponder;
    options?: SendMessageOptions;
    onSuccess?: () => void;
  }): boolean {
    if (this.pendingTurns.has(input.key)) return false;
    this.pendingTurns.add(input.key);
    void this.run(
      input.chatId,
      input.key,
      input.text,
      input.responder,
      {
        ...input.options,
        responderTimeoutMs: undefined,
      },
    )
      .then(() => {
        input.onSuccess?.();
      })
      .catch((error) => {
        const safeError = appSafeResponderError(error);
        this.input.appendEvent("worker.app_responder_turn_failed", {
          key: input.key,
          chat_id: input.chatId,
          safe_error_code: safeError.code,
        });
      })
      .finally(() => {
        this.pendingTurns.delete(input.key);
      });
    return true;
  }

  private async complete(
    input: SystemResponderCompletionInput,
  ): Promise<MessageSendResult> {
    return await this.completion.complete(input);
  }

  private handleError(input: {
    chatId: string;
    messageId: string;
    turn: TurnRecord;
    error: unknown;
  }): MessageSendResult {
    if (isResponderCancelError(input.error)) {
      const cancelledTurn = this.input.finalizeCancelledTurn(
        input.chatId,
        input.turn.id,
      );
      return {
        accepted: this.acceptedMessageForExistingOrSynthetic(
          input.chatId,
          input.messageId,
          cancelledTurn,
        ),
        replies: [],
        turn: cancelledTurn,
        next_cursor: cancelledTurn.cursor,
      };
    }
    if (isResponderRuntimeInterruption(input.error)) {
      const continuation = this.input.markResponderNonPublicContinuation(
        input.chatId,
        input.turn.id,
        null,
      );
      this.input.touchChat(input.chatId);
      return {
        accepted: this.acceptedMessageForExistingOrSynthetic(
          input.chatId,
          input.messageId,
          continuation.turn,
        ),
        replies: [],
        turn: continuation.turn,
        next_cursor: continuation.turn.cursor,
      };
    }
    if (isNonPublicContinuationDeliveryError(input.error)) {
      const continuation = this.input.markResponderNonPublicContinuation(
        input.chatId,
        input.turn.id,
        appNonPublicContinuationSafeErrorCode(input.error),
      );
      this.input.touchChat(input.chatId);
      return {
        accepted: this.acceptedMessageForExistingOrSynthetic(
          input.chatId,
          input.messageId,
          continuation.turn,
        ),
        replies: [],
        turn: continuation.turn,
        next_cursor: continuation.turn.cursor,
      };
    }
    const limitedDelivery = appLimitedDeliveryForError(input.error);
    if (limitedDelivery) {
      const delivered = this.input.finalizeResponderLimitedDelivery(
        input.chatId,
        input.turn.id,
        limitedDelivery,
      );
      this.input.touchChat(input.chatId);
      return {
        accepted: this.acceptedMessageForExistingOrSynthetic(
          input.chatId,
          input.messageId,
          delivered.turn,
        ),
        reply: delivered.reply,
        replies: delivered.replies,
        turn: delivered.turn,
        next_cursor: delivered.reply?.cursor ?? delivered.turn.cursor,
      };
    }
    this.failTurn(input.chatId, input.turn, input.error);
    throw input.error;
  }

  private failTurn(chatId: string, turn: TurnRecord, error: unknown): void {
    const safeError = appSafeResponderError(error);
    const runtimeFault = this.input.runtimeFaultRecordForTurn(turn.id);
    const isRuntimeFault = Boolean(runtimeFault);
    const isRetryableRuntimeFault = runtimeFault?.retryable === true;
    this.input.upsertAssistantTurnFailure(chatId, turn.id, safeError, {
      retryable: isRetryableRuntimeFault,
    });
    const failureKind = isRuntimeFault ? "runtime.fault" : "turn.failed";
    if (!this.input.hasTurnEventKind(turn.id, failureKind)) {
      this.input.appendTurnEvent(chatId, turn.id, {
        kind: failureKind,
        payload: runtimeFault ?? {
          safeLabel: safeError.message,
          safeErrorCode: safeError.code,
        },
      });
    }
    const failedTurn = this.input.updateTurnState(
      turn.id,
      isRuntimeFault ? "runtime_fault" : "failed",
      {
        safeStatusLabel: isRuntimeFault ? "Runtime fault" : "Failed",
        retryable: isRetryableRuntimeFault,
        cancellable: false,
        safeErrorCode: safeError.code,
      },
    );
    this.input.appendTerminalTurnStateChanged(failedTurn);
    this.input.touchChat(chatId);
  }

  private acceptedMessageForExistingOrSynthetic(
    chatId: string,
    messageId: string,
    turn: TurnRecord,
  ): MessageRecord {
    const existingMessage = this.input.getMessageRow(messageId);
    return existingMessage
      ? messageFromRow(existingMessage, this.input.refsForMessage(messageId))
      : systemAcceptedMessage(chatId, messageId, turn);
  }
}
