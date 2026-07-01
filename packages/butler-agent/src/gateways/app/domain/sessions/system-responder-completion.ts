import type { RuntimeTurnEventInput } from "../../../../agent/events/turn-events.ts";
import type { DeliveryLimitationMetadata } from "../../infrastructure/transport/app-delivery-projection.ts";
import { publicDeliveryMetadataForProjection } from "../../infrastructure/transport/btcc-public-projection.ts";
import type {
  MessageRecord,
  MessageSendResult,
  TurnRecord,
} from "../../interface/protocol/app-protocol.ts";
import type { AppMessageResponderResult } from "./message-responder-contract.ts";
import type { ProgressSummaryInput } from "../progress-summary/progress-row-normalizer.ts";
import type {
  SystemResponderAppendTurnEvent,
  SystemResponderCompletionInput,
  SystemResponderTurnStoreInput,
} from "./system-responder-turn-contract.ts";

export class AppSystemResponderCompletionProjector {
  constructor(private readonly input: SystemResponderTurnStoreInput) {}

  async complete(
    input: SystemResponderCompletionInput,
  ): Promise<MessageSendResult> {
    const appendProgress = (row: ProgressSummaryInput) =>
      this.input.appendProgressSummaryEvent(input.chatId, input.turn.id, row);
    const appendTurnEvent = (event: RuntimeTurnEventInput) =>
      this.input.appendTurnEvent(input.chatId, input.turn.id, event);
    const response = await this.input.runResponder(
      input.chatId,
      input.turn.id,
      input.messageId,
      input.text,
      input.responder,
      input.options,
      appendProgress,
      appendTurnEvent,
    );
    for (const row of response.progress ?? []) appendProgress(row);
    this.ensureFinalStarted(input.turn.id, appendTurnEvent);
    const limitedDelivery =
      response.delivery?.delivery_state === "delivered_with_limitations"
        ? response.delivery
        : null;
    return input.options.suppressAssistantReplies
      ? this.completeSuppressedReply(input, appendTurnEvent, limitedDelivery)
      : this.completeVisibleReply(
          input,
          response,
          appendTurnEvent,
          limitedDelivery,
        );
  }

  private completeSuppressedReply(
    input: Pick<SystemResponderCompletionInput, "chatId" | "messageId" | "turn">,
    appendTurnEvent: SystemResponderAppendTurnEvent,
    limitedDelivery: DeliveryLimitationMetadata | null,
  ): MessageSendResult {
    this.ensureFinalCompleted(input.turn.id, appendTurnEvent, {
      textChars: 0,
      limitedDelivery,
    });
    const deliveredTurn = this.markDelivered(input.turn.id, limitedDelivery);
    this.ensureTurnCompleted(input.turn.id, appendTurnEvent, limitedDelivery);
    this.input.touchChat(input.chatId);
    const accepted = systemAcceptedMessage(
      input.chatId,
      input.messageId,
      deliveredTurn,
    );
    return {
      accepted,
      replies: [],
      turn: deliveredTurn,
      next_cursor: deliveredTurn.cursor,
    };
  }

  private completeVisibleReply(
    input: Pick<SystemResponderCompletionInput, "chatId" | "turn">,
    response: AppMessageResponderResult,
    appendTurnEvent: SystemResponderAppendTurnEvent,
    limitedDelivery: DeliveryLimitationMetadata | null,
  ): MessageSendResult {
    const responderFiles = this.input.createResponderFiles(
      input.chatId,
      response.files ?? [],
    );
    const replies = this.input.insertOrReplaceAssistantReplies(
      input.chatId,
      input.turn.id,
      response.texts,
      responderFiles,
    );
    this.ensureFinalCompleted(input.turn.id, appendTurnEvent, {
      textChars: response.texts.join("\n\n").length,
      limitedDelivery,
    });
    const deliveredTurn = this.markDelivered(input.turn.id, limitedDelivery);
    this.ensureTurnCompleted(input.turn.id, appendTurnEvent, limitedDelivery);
    this.input.touchChat(input.chatId);
    const publicLimitedDelivery = limitedDelivery
      ? publicDeliveryMetadataForProjection(limitedDelivery)
      : null;
    const projectedReplies = limitedDelivery
      ? replies.map((reply) => ({ ...reply, ...publicLimitedDelivery! }))
      : replies;
    const reply = projectedReplies.at(-1)!;
    return {
      accepted: reply,
      reply,
      replies: projectedReplies,
      turn: deliveredTurn,
      next_cursor: reply.cursor,
    };
  }

  private ensureFinalStarted(
    turnId: string,
    appendTurnEvent: SystemResponderAppendTurnEvent,
  ): void {
    if (this.input.hasTurnEventKind(turnId, "message.final.started")) return;
    appendTurnEvent({
      kind: "message.final.started",
      payload: { safeLabel: "Preparing final answer" },
    });
  }

  private ensureFinalCompleted(
    turnId: string,
    appendTurnEvent: SystemResponderAppendTurnEvent,
    input: {
      textChars: number;
      limitedDelivery: DeliveryLimitationMetadata | null;
    },
  ): void {
    if (this.input.hasTurnEventKind(turnId, "message.final.completed")) return;
    appendTurnEvent({
      kind: "message.final.completed",
      payload: {
        safeLabel: input.limitedDelivery
          ? "Final answer ready with limitations"
          : "Final answer ready",
        textChars: input.textChars,
        ...(input.limitedDelivery ?? {}),
      },
    });
  }

  private ensureTurnCompleted(
    turnId: string,
    appendTurnEvent: SystemResponderAppendTurnEvent,
    limitedDelivery: DeliveryLimitationMetadata | null,
  ): void {
    if (this.input.hasTurnEventKind(turnId, "turn.completed")) return;
    appendTurnEvent({
      kind: "turn.completed",
      payload: {
        safeLabel: limitedDelivery ? "Completed with limitations" : "Completed",
        ...(limitedDelivery ?? {}),
      },
    });
  }

  private markDelivered(
    turnId: string,
    limitedDelivery: DeliveryLimitationMetadata | null,
  ): TurnRecord {
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
  }
}

export function systemAcceptedMessage(
  chatId: string,
  messageId: string,
  turn: TurnRecord,
): MessageRecord {
  return {
    id: messageId,
    chat_id: chatId,
    role: "system_event",
    text: "",
    status: "delivered",
    retryable: false,
    cursor: turn.cursor,
    created_at: turn.updated_at,
    updated_at: turn.updated_at,
  };
}
