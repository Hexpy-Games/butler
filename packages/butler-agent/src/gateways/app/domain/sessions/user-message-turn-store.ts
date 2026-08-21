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
import { subsessionResultStatusLabel } from "../../../core/turn-execution-controls.ts";

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
    const clientMessageId = input.client_message_id?.trim() ||
      `client-${crypto.randomUUID()}`;
    await this.input.createQueuedMessage(
      { ...input, chat_id: chatId, text, client_message_id: clientMessageId },
      admittedVisual,
    );
    const queued = this.input.findQueuedMessageByClientId(
      chatId,
      clientMessageId,
    );
    if (!queued) throw new Error("queued_message_persisted_row_missing");
    const dispatched = await this.input.dispatchQueuedSessionMessage(
      chatId,
      queued.id,
      responder,
      options,
    );
    if (dispatched) return dispatched;
    return {
      queued: this.input.findQueuedMessageByClientId(chatId, clientMessageId) ??
        queued,
      replies: [],
      next_cursor: maxMessageCursor(this.input.listMessages(chatId)),
    };
  }

  async dispatchQueuedMessage(
    queued: import("../../infrastructure/core/records.ts").QueuedMessageRow,
    responder?: AppMessageResponder,
    options: SendMessageOptions = {},
    visualAdmission?: VisualImageAdmissionResult,
  ): Promise<MessageSendResult> {
    const chatId = queued.chat_id;
    const text = queued.text.trim();
    const controls = this.input.controlResolutionFromRow(queued) ??
      this.input.resolveControlsForMessageSend(
        chatId,
        this.input.queuedControlsFromRow(queued),
      );
    const attachableFiles = this.input.messageFilesForQueuedRow(queued);
    const admission = visualAdmission ?? await this.input.admitVisualAttachments(
      attachableFiles,
      controls.controls.model,
    );
    if (!queued.turn_id && queued.client_message_id) {
      const existing = this.input.listMessages(chatId).find(
        (message) =>
          message.role === "user" &&
          message.id === queued.client_message_id &&
          message.turn_id,
      );
      if (existing?.turn_id) {
        return await this.resumeQueuedTurn({
          queued: {
            ...queued,
            turn_id: existing.turn_id,
            dispatched_message_id: existing.id,
          },
          responder,
          options,
          text,
          controls,
          attachableFiles,
          visualAdmission: admission,
        });
      }
    }
    if (queued.turn_id) {
      return await this.resumeQueuedTurn({
        queued,
        responder,
        options,
        text,
        controls,
        attachableFiles,
        visualAdmission: admission,
      });
    }
    return await this.startQueuedTurn({
      queued,
      responder,
      options,
      text,
      controls,
      attachableFiles,
      visualAdmission: admission,
    });
  }

  private async startQueuedTurn(input: {
    queued: import("../../infrastructure/core/records.ts").QueuedMessageRow;
    responder?: AppMessageResponder;
    options: SendMessageOptions;
    text: string;
    controls: import("../../../core/turn-execution-controls.ts").TurnControlResolution;
    attachableFiles: import("../message-files/message-file-store.ts").MessageFileRow[];
    visualAdmission?: VisualImageAdmissionResult;
  }): Promise<MessageSendResult> {
    const claimId = requireQueuedClaimId(input.queued);
    assertQueuedClaim(this.input, input.queued, claimId);
    const admission = this.input.runInTransaction(() => {
      assertQueuedClaim(this.input, input.queued, claimId);
      const turn = this.input.insertTurn(
        input.queued.chat_id,
        "accepted",
        "Accepted",
        input.controls,
      );
      const executionControls = turn.execution_controls;
      if (!executionControls) throw new Error("accepted_turn_execution_controls_missing");
      const accepted = this.input.insertMessage(
        input.queued.chat_id,
        "user",
        input.text,
        "sent",
        {
          clientMessageId: input.queued.client_message_id ?? undefined,
          turnId: turn.id,
          attachments: input.attachableFiles,
        },
      );
      this.input.setTurnUserMessage(turn.id, accepted.id);
      if (!this.input.recordDispatchResult(input.queued.chat_id, input.queued.id, claimId, {
        messageId: accepted.id,
        turnId: turn.id,
      })) throw new Error("queued_message_claim_lost");
      const synthesis = input.controls.subsession_result;
      const thinkingTurn = this.input.updateTurnState(turn.id, "thinking", {
        safeStatusLabel: synthesis
          ? subsessionResultStatusLabel(synthesis)
          : "Thinking",
        cancellable: !synthesis,
      });
      return { turn, accepted, executionControls, thinkingTurn };
    });
    const { turn, accepted, executionControls, thinkingTurn } = admission;
    if (this.input.isPublicUserMessage(input.queued.chat_id, input.text)) {
      this.input.appendEvent("message.created", { message: accepted });
      this.appendCapturedFeedback(
        input.queued.chat_id,
        turn.id,
        accepted.id,
        input.text,
      );
    }
    this.input.appendTurnAcknowledgedEvent(input.queued.chat_id, turn.id);
    this.input.appendEvent("turn.state_changed", { turn: thinkingTurn });
    if (!input.responder) {
      assertQueuedClaim(this.input, input.queued, claimId);
      const queuedTurn = this.input.enqueueAppTransportTurn({
        chatId: input.queued.chat_id,
        turnId: turn.id,
        message: accepted,
        text: input.text,
        executionControls,
        queueClaimId: claimId,
        ...(input.controls.authority_request_ref
          ? { authorityRequestRef: input.controls.authority_request_ref }
          : {}),
        ...(input.visualAdmission ? { visualAdmission: input.visualAdmission } : {}),
      });
      assertQueuedClaim(this.input, input.queued, claimId);
      return {
        accepted,
        replies: [],
        turn: queuedTurn,
        next_cursor: accepted.cursor,
      };
    }
    const responderOptions = {
      ...input.options,
      controls: input.controls.controls,
    };
    if (input.options.deferResponderTurns) {
      assertQueuedClaim(this.input, input.queued, claimId);
      this.dispatchDeferredResponderTurn({
        chatId: input.queued.chat_id,
        turnId: turn.id,
        messageId: accepted.id,
        text: input.text,
        responder: input.responder,
        options: responderOptions,
        queuedMessageId: input.queued.id,
        claimId,
      });
      return {
        accepted,
        replies: [],
        turn: thinkingTurn,
        next_cursor: accepted.cursor,
      };
    }
    assertQueuedClaim(this.input, input.queued, claimId);
    const result = await this.completeResponderTurn({
      chatId: input.queued.chat_id,
      turnId: turn.id,
      messageId: accepted.id,
      text: input.text,
      responder: input.responder,
      options: responderOptions,
      queuedMessageId: input.queued.id,
      queueClaimId: claimId,
    });
    return { accepted, ...result };
  }

  private async resumeQueuedTurn(input: {
    queued: import("../../infrastructure/core/records.ts").QueuedMessageRow;
    responder?: AppMessageResponder;
    options: SendMessageOptions;
    text: string;
    controls: import("../../../core/turn-execution-controls.ts").TurnControlResolution;
    attachableFiles: import("../message-files/message-file-store.ts").MessageFileRow[];
    visualAdmission?: VisualImageAdmissionResult;
  }): Promise<MessageSendResult> {
    const claimId = requireQueuedClaimId(input.queued);
    assertQueuedClaim(this.input, input.queued, claimId);
    const turn = this.input.getTurn(input.queued.turn_id!);
    const accepted = input.queued.dispatched_message_id
      ? this.input.messageRecordById(input.queued.dispatched_message_id)
      : turn.user_message_id
        ? this.input.messageRecordById(turn.user_message_id)
        : undefined;
    if (!accepted) throw new Error("queued_turn_user_message_missing");
    const existingReplies = this.input.listMessages(input.queued.chat_id)
      .filter((message) => message.role === "assistant" && message.turn_id === turn.id);
    if (["delivered", "failed", "cancelled", "runtime_fault"].includes(turn.state)) {
      return {
        accepted,
        replies: existingReplies,
        ...(existingReplies.at(-1) ? { reply: existingReplies.at(-1) } : {}),
        turn,
        next_cursor: existingReplies.at(-1)?.cursor ?? accepted.cursor,
      };
    }
    if (!input.responder) {
      const executionControls = turn.execution_controls;
      if (!executionControls) throw new Error("queued_turn_execution_controls_missing");
      assertQueuedClaim(this.input, input.queued, claimId);
      const queuedTurn = this.input.enqueueAppTransportTurn({
        chatId: input.queued.chat_id,
        turnId: turn.id,
        message: accepted,
        text: input.text,
        executionControls,
        queueClaimId: claimId,
        queueReplay: true,
        ...(input.controls.authority_request_ref
          ? { authorityRequestRef: input.controls.authority_request_ref }
          : {}),
        ...(input.visualAdmission ? { visualAdmission: input.visualAdmission } : {}),
      });
      assertQueuedClaim(this.input, input.queued, claimId);
      return { accepted, replies: [], turn: queuedTurn, next_cursor: accepted.cursor };
    }
    assertQueuedClaim(this.input, input.queued, claimId);
    const result = await this.completeResponderTurn({
      chatId: input.queued.chat_id,
      turnId: turn.id,
      messageId: accepted.id,
      text: input.text,
      responder: input.responder,
      options: { ...input.options, controls: input.controls.controls },
      queuedMessageId: input.queued.id,
      queueClaimId: claimId,
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
    queuedMessageId?: string;
    claimId?: string;
  }): void {
    const options = {
      ...input.options,
      responderTimeoutMs: undefined,
    };
    void (async () => {
      try {
        const result = await this.completeResponderTurn({
          ...input,
          options,
          ...(input.queuedMessageId ? { queuedMessageId: input.queuedMessageId } : {}),
          ...(input.claimId ? { queueClaimId: input.claimId } : {}),
        });
        if (input.claimId) this.input.acknowledgeQueuedMessageForTurn({
          chatId: input.chatId,
          turnId: input.turnId,
          claimId: input.claimId,
          resultMessageId: result.replies.at(-1)?.id,
        });
      } catch (error) {
        const turn = error && typeof error === "object" && "turn" in error
          ? (error as { turn?: TurnRecord }).turn
          : undefined;
        const failureMessage = turn
          ? this.input.listMessages(input.chatId).find(
            (message) => message.role === "assistant" && message.turn_id === turn.id,
          )
          : undefined;
        if (input.claimId) this.input.acknowledgeQueuedMessageForTurn({
          chatId: input.chatId,
          turnId: input.turnId,
          claimId: input.claimId,
          ...(failureMessage ? { resultMessageId: failureMessage.id } : {}),
          ...(turn?.safe_error_code ? { safeErrorCode: turn.safe_error_code } : {
            safeErrorCode: "queued_message_dispatch_failed",
          }),
        });
      }
      try {
        await this.input.drainQueuedSessionMessages(
          input.chatId,
          input.responder,
          input.options,
        );
      } catch {
        // The durable lease leaves the next accepted input recoverable.
      }
    })();
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

function requireQueuedClaimId(
  queued: import("../../infrastructure/core/records.ts").QueuedMessageRow,
): string {
  if (!queued.claim_id) throw new Error("queued_message_claim_lost");
  return queued.claim_id;
}

function assertQueuedClaim(
  input: UserMessageTurnStoreInput,
  queued: import("../../infrastructure/core/records.ts").QueuedMessageRow,
  claimId: string,
): void {
  if (!input.assertQueuedMessageClaim(queued.chat_id, queued.id, claimId)) {
    throw new Error("queued_message_claim_lost");
  }
}
