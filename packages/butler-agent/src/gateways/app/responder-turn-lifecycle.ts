import type { RuntimeTurnEventInput } from "../../agent/events/turn-events.ts";
import { isRuntimeCancellationFailure } from "../../agent/turn/runtime-cancellation.ts";
import type {
  MessageRecord,
  ProgressSummaryRow,
  TurnRecord,
} from "./protocol.ts";
import {
  appLimitedDeliveryForError,
  appSafeResponderError,
  type AppLimitedDelivery,
} from "./failure-ux-contract.ts";
import type {
  AppMessageResponder,
  AppMessageResponderResult,
  SendMessageOptions,
} from "./store.ts";

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
  ): { reply: MessageRecord; replies: MessageRecord[]; turn: TurnRecord };
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
  updateTurnDelivered(turnId: string): TurnRecord;
  updateTurnFailed(
    chatId: string,
    turnId: string,
    safeError: { code: string; message: string },
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
          safeLabel: "Final answer ready",
          textChars: response.texts.join("\n\n").length,
        },
      });
    }
    const deliveredTurn = context.updateTurnDelivered(input.turnId);
    if (!context.hasTurnEventKind(input.turnId, "turn.completed")) {
      context.appendTurnEvent({
        kind: "turn.completed",
        payload: { safeLabel: "Completed" },
      });
    }
    context.touchChat(input.chatId);
    await context.drainQueuedSessionMessages(
      input.chatId,
      input.responder,
      input.options,
    );

    const reply = replies.at(-1)!;
    return {
      reply,
      replies,
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
    const limitedDelivery = appLimitedDeliveryForError(error);
    if (limitedDelivery) {
      const delivered = context.finalizeResponderLimitedDelivery(
        input.chatId,
        input.turnId,
        limitedDelivery,
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
        next_cursor: delivered.reply.cursor,
      };
    }
    const safeError = appSafeResponderError(error);
    const failedTurn = context.updateTurnFailed(
      input.chatId,
      input.turnId,
      safeError,
    );
    context.touchChat(input.chatId);
    await context.drainQueuedSessionMessages(
      input.chatId,
      input.responder,
      input.options,
    );
    throw Object.assign(
      error instanceof Error ? error : new Error(String(error)),
      { turn: failedTurn },
    );
  } finally {
    context.cleanupTurnEventSequences(input.chatId, input.turnId);
  }
}

export function isResponderCancelError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as { code?: unknown; name?: unknown };
  return record.code === "turn_cancelled" ||
    record.name === "AppResponderCancelledError" ||
    isRuntimeCancellationFailure(record);
}
