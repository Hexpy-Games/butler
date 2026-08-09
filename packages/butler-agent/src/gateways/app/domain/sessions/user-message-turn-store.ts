import { maxMessageCursor } from "./session-read-model.ts";
import type {
  MessageRecord,
  MessageSendRequest,
  MessageSendResult,
  TurnRecord,
} from "../../interface/protocol/app-protocol.ts";
import type {
  AppMessageResponder,
  SendMessageOptions,
} from "./message-responder-contract.ts";
import { AppUserMessageResponderTurn } from "./user-message-responder-turn.ts";
import type {
  UserMessageTurnStoreInput,
  UserResponderTurnInput,
} from "./user-message-turn-contract.ts";
import type { VisualImageAdmissionResult } from "../../../../agent/image-attachment/contracts.ts";

type CapturedUserFeedback = {
  entry: {
    feedback_id: string;
    category: string;
    scope: string;
    target_ref?: string | null;
  };
  reason: string;
};

export class AppUserMessageTurnStore {
  private readonly responderTurn: AppUserMessageResponderTurn;

  constructor(private readonly input: UserMessageTurnStoreInput) {
    this.responderTurn = new AppUserMessageResponderTurn(input);
  }

  async sendMessage(
    input: MessageSendRequest,
    responder?: AppMessageResponder,
    options: SendMessageOptions = {},
    admittedVisual?: VisualImageAdmissionResult,
  ): Promise<MessageSendResult> {
    const chatId = input.chat_id?.trim() || this.input.defaultChatId;
    this.input.ensureChat(chatId);
    const text = (input.text ?? "").trim();
    const attachableFiles = this.input.validateAttachable(
      chatId,
      input.attachments ?? [],
    );
    const controlResolution = this.input.resolveControlsForMessageSend(
      chatId,
      input,
    );
    const visualAdmission = admittedVisual ?? await this.input.admitVisualAttachments(
      attachableFiles,
      controlResolution.controls.model,
    );
    if (
      input.queue_policy === "enqueue_if_busy" &&
      this.input.sessionHasActiveTurn(chatId)
    ) {
      const queue = await this.input.createQueuedMessage(input, visualAdmission);
      return {
        queued: queue.queued_messages.at(-1),
        replies: [],
        next_cursor: maxMessageCursor(this.input.listMessages(chatId)),
      };
    }
    const turn = this.input.insertTurn(
      chatId,
      "accepted",
      "Accepted",
      controlResolution,
    );
    const executionControls = turn.execution_controls;
    if (!executionControls) {
      throw new Error("accepted_turn_execution_controls_missing");
    }
    const accepted = this.input.insertMessage(chatId, "user", text, "sent", {
      clientMessageId: input.client_message_id,
      turnId: turn.id,
      attachments: attachableFiles,
    });
    this.input.setTurnUserMessage(turn.id, accepted.id);
    this.input.appendEvent("message.created", { message: accepted });
    this.appendCapturedFeedback(chatId, turn.id, accepted.id, text);
    this.input.appendTurnAcknowledgedEvent(chatId, turn.id);
    const thinkingTurn = this.input.updateTurnState(turn.id, "thinking", {
      safeStatusLabel: "Thinking",
      cancellable: true,
    });
    this.input.appendEvent("turn.state_changed", { turn: thinkingTurn });

    if (!responder) {
      const queuedTurn = this.input.enqueueAppTransportTurn({
        chatId,
        turnId: turn.id,
        message: accepted,
        text,
        executionControls,
        ...(visualAdmission ? { visualAdmission } : {}),
      });
      return {
        accepted,
        replies: [],
        turn: queuedTurn,
        next_cursor: accepted.cursor,
      };
    }

    const responderOptions = {
      ...options,
      controls: controlResolution.controls,
    };
    if (options.deferResponderTurns) {
      this.dispatchDeferredResponderTurn({
        chatId,
        turnId: turn.id,
        messageId: accepted.id,
        text,
        responder,
        options: responderOptions,
      });
      return {
        accepted,
        replies: [],
        turn: thinkingTurn,
        next_cursor: accepted.cursor,
      };
    }

    const result = await this.completeResponderTurn({
      chatId,
      turnId: turn.id,
      messageId: accepted.id,
      text,
      responder,
      options: responderOptions,
    });
    return { accepted, ...result };
  }

  dispatchDeferredResponderTurn(input: {
    chatId: string;
    turnId: string;
    messageId: string;
    text: string;
    responder: AppMessageResponder;
    options: SendMessageOptions;
  }): void {
    const options = {
      ...input.options,
      responderTimeoutMs: undefined,
    };
    void this.completeResponderTurn({ ...input, options }).catch(
      () => undefined,
    );
  }

  async completeResponderTurn(input: UserResponderTurnInput): Promise<{
    reply?: MessageRecord;
    replies: MessageRecord[];
    turn: TurnRecord;
    next_cursor: number;
  }> {
    return await this.responderTurn.complete(input);
  }

  private appendCapturedFeedback(
    chatId: string,
    turnId: string,
    messageId: string,
    text: string,
  ): void {
    const capturedFeedback = captureUserFeedbackFromMessage({
      butlerData: this.input.butlerData,
      text,
      messageId,
      turnId,
      chatId,
    });
    if (!capturedFeedback) return;
    this.input.appendTurnEvent(chatId, turnId, {
      kind: "cognition.feedback.captured",
      payload: {
        safeLabel: "Feedback captured",
        feedbackId: capturedFeedback.entry.feedback_id,
        category: capturedFeedback.entry.category,
        scope: capturedFeedback.entry.scope,
        targetRef: capturedFeedback.entry.target_ref,
        reason: capturedFeedback.reason,
      },
    });
  }
}

function captureUserFeedbackFromMessage(
  _input: unknown,
): CapturedUserFeedback | null {
  return null;
}
