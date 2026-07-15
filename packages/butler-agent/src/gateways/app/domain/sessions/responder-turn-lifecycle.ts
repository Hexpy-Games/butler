import type { RuntimeTurnEventInput } from "../../../../agent/events/turn-events.ts";
import { isRuntimeCancellationFailure } from "../../../../agent/turn/runtime-cancellation.ts";
import type {
  MessageRecord,
  ProgressSummaryRow,
  TurnRecord,
} from "../../interface/protocol/app-protocol.ts";
import {
  appLimitedDeliveryForError,
  appNonPublicContinuationSafeErrorCode,
  isNonPublicContinuationDeliveryError,
  type AppLimitedDelivery,
} from "../../infrastructure/transport/failure-ux-contract.ts";
import { publicDeliveryMetadataForProjection } from "../../infrastructure/transport/btcc-public-projection.ts";
import type {
  AppMessageResponder,
  AppMessageResponderResult,
  SendMessageOptions,
} from "./message-responder-contract.ts";
import { isResponderRuntimeInterruption } from "./responder-runtime-interruption.ts";

type ProgressSummaryInput = Omit<ProgressSummaryRow, "created_at"> & {
  created_at?: string;
};

export interface CompletedResponderTurnResult {
  reply?: MessageRecord;
  replies: MessageRecord[];
  turn: TurnRecord;
  next_cursor: number;
}

export interface CompleteResponderTurnInput {
  chatId: string;
  turnId: string;
  messageId: string;
  text: string;
  responder: AppMessageResponder;
  options: SendMessageOptions;
}

export interface CompleteResponderTurnContext<FileRecord> {
  appendProgress(row: ProgressSummaryInput): void;
  appendTurnEvent(event: RuntimeTurnEventInput): void;
  cleanupTurnEventSequences(chatId: string, turnId: string): void;
  createResponderMessageFiles(
    chatId: string,
    files: AppMessageResponderResult["files"],
  ): FileRecord[];
  drainQueuedSessionMessages(
    chatId: string,
    responder: AppMessageResponder,
    options: SendMessageOptions,
  ): Promise<void>;
  finalizeResponderLimitedDelivery(
    chatId: string,
    turnId: string,
    limitedDelivery: AppLimitedDelivery,
  ): { reply?: MessageRecord; replies: MessageRecord[]; turn: TurnRecord };
  markResponderNonPublicContinuation(
    chatId: string,
    turnId: string,
    safeErrorCode?: "provider_round_timeout" | null,
  ): { reply?: MessageRecord; replies: MessageRecord[]; turn: TurnRecord };
  routeResponderRuntimeInterruption(
    input: CompleteResponderTurnInput,
    error: unknown,
  ): void;
  finalizeCancelledTurn(chatId: string, turnId: string): TurnRecord;
  hasTurnEventKind(turnId: string, kind: string): boolean;
  insertOrReplaceAssistantReplies(
    chatId: string,
    turnId: string,
    texts: string[],
    files: FileRecord[],
  ): MessageRecord[];
  runResponder(
    chatId: string,
    turnId: string,
    messageId: string,
    text: string,
    responder: AppMessageResponder,
    options: SendMessageOptions,
    onProgress: (row: ProgressSummaryInput) => void,
    onTurnEvent: (event: RuntimeTurnEventInput) => void,
  ): Promise<AppMessageResponderResult>;
  touchChat(chatId: string): void;
  updateTurnDelivered(
    turnId: string,
    delivery?: AppMessageResponderResult["delivery"] | null,
  ): TurnRecord;
}

export async function completeResponderTurn<FileRecord>(
  input: CompleteResponderTurnInput,
  context: CompleteResponderTurnContext<FileRecord>,
): Promise<CompletedResponderTurnResult> {
  try {
    const response = await context.runResponder(
      input.chatId,
      input.turnId,
      input.messageId,
      input.text,
      input.responder,
      input.options,
      context.appendProgress,
      context.appendTurnEvent,
    );
    for (const row of response.progress ?? []) context.appendProgress(row);
    const responderFiles = context.createResponderMessageFiles(
      input.chatId,
      response.files ?? [],
    );
    const limitedDelivery = response.delivery?.delivery_state === "delivered_with_limitations" ||
      response.delivery?.delivery_state === "delivered_with_continuation"
      ? response.delivery
      : null;
    if (!context.hasTurnEventKind(input.turnId, "message.final.started")) {
      context.appendTurnEvent({
        kind: "message.final.started",
        payload: { safeLabel: "Preparing final answer" },
      });
    }
    const replies = context.insertOrReplaceAssistantReplies(
      input.chatId,
      input.turnId,
      response.texts,
      responderFiles,
    );
    if (!context.hasTurnEventKind(input.turnId, "message.final.completed")) {
      context.appendTurnEvent({
        kind: "message.final.completed",
        payload: {
          safeLabel: limitedDelivery
            ? "Final answer ready with limitations"
            : "Final answer ready",
          textChars: response.texts.join("\n\n").length,
          ...(limitedDelivery ?? {}),
        },
      });
    }
    const deliveredTurn = context.updateTurnDelivered(input.turnId, limitedDelivery);
    if (!context.hasTurnEventKind(input.turnId, "turn.completed")) {
      context.appendTurnEvent({
        kind: "turn.completed",
        payload: {
          safeLabel: limitedDelivery ? "Completed with limitations" : "Completed",
          ...(limitedDelivery ?? {}),
        },
      });
    }
    context.touchChat(input.chatId);
    await context.drainQueuedSessionMessages(
      input.chatId,
      input.responder,
      input.options,
    );

    const publicLimitedDelivery = limitedDelivery
      ? publicDeliveryMetadataForProjection(limitedDelivery)
      : null;
    const projectedReplies = publicLimitedDelivery
      ? replies.map((reply) => ({ ...reply, ...publicLimitedDelivery }))
      : replies;
    const reply = projectedReplies.at(-1)!;
    return {
      reply,
      replies: projectedReplies,
      turn: deliveredTurn,
      next_cursor: reply.cursor,
    };
  } catch (error) {
    if (isResponderCancelError(error)) {
      const cancelledTurn = context.finalizeCancelledTurn(
        input.chatId,
        input.turnId,
      );
      await context.drainQueuedSessionMessages(
        input.chatId,
        input.responder,
        input.options,
      );
      return {
        replies: [],
        turn: cancelledTurn,
        next_cursor: cancelledTurn.cursor,
      };
    }
    if (isResponderRuntimeInterruption(error)) {
      routeResponderRuntimeInterruptionSafely(context, input, error);
      const continuation = context.markResponderNonPublicContinuation(
        input.chatId,
        input.turnId,
        null,
      );
      context.touchChat(input.chatId);
      await context.drainQueuedSessionMessages(
        input.chatId,
        input.responder,
        input.options,
      );
      return {
        reply: continuation.reply,
        replies: continuation.replies,
        turn: continuation.turn,
        next_cursor: continuation.reply?.cursor ?? continuation.turn.cursor,
      };
    }
    const limitedDelivery = appLimitedDeliveryForError(error);
    if (limitedDelivery) {
      const routed = routeResponderRuntimeInterruptionSafely(
        context,
        input,
        error,
      );
      const delivered = routed
        ? context.finalizeResponderLimitedDelivery(
            input.chatId,
            input.turnId,
            limitedDelivery,
          )
        : context.markResponderNonPublicContinuation(
            input.chatId,
            input.turnId,
            null,
          );
      context.touchChat(input.chatId);
      await context.drainQueuedSessionMessages(
        input.chatId,
        input.responder,
        input.options,
      );
      return {
        reply: delivered.reply,
        replies: delivered.replies,
        turn: delivered.turn,
        next_cursor: delivered.reply?.cursor ?? delivered.turn.cursor,
      };
    }
    if (isNonPublicContinuationDeliveryError(error)) {
      routeResponderRuntimeInterruptionSafely(context, input, error);
      const continuation = context.markResponderNonPublicContinuation(
        input.chatId,
        input.turnId,
        appNonPublicContinuationSafeErrorCode(error),
      );
      context.touchChat(input.chatId);
      await context.drainQueuedSessionMessages(
        input.chatId,
        input.responder,
        input.options,
      );
      return {
        reply: continuation.reply,
        replies: continuation.replies,
        turn: continuation.turn,
        next_cursor: continuation.reply?.cursor ?? continuation.turn.cursor,
      };
    }
    routeResponderRuntimeInterruptionSafely(context, input, error);
    const continuation = context.markResponderNonPublicContinuation(
      input.chatId,
      input.turnId,
      null,
    );
    context.touchChat(input.chatId);
    await context.drainQueuedSessionMessages(
      input.chatId,
      input.responder,
      input.options,
    );
    return {
      reply: continuation.reply,
      replies: continuation.replies,
      turn: continuation.turn,
      next_cursor: continuation.reply?.cursor ?? continuation.turn.cursor,
    };
  } finally {
    context.cleanupTurnEventSequences(input.chatId, input.turnId);
  }
}

function routeResponderRuntimeInterruptionSafely<FileRecord>(
  context: CompleteResponderTurnContext<FileRecord>,
  input: CompleteResponderTurnInput,
  error: unknown,
): boolean {
  try {
    context.routeResponderRuntimeInterruption(input, error);
    return true;
  } catch {
    // The accepted App turn remains the fallback owner. A recovery-store
    // outage must park the turn, not escape this lifecycle as another error.
    return false;
  }
}

export function isResponderCancelError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as { code?: unknown; name?: unknown };
  return record.code === "turn_cancelled" ||
    record.name === "AppResponderCancelledError" ||
    isRuntimeCancellationFailure(record);
}
