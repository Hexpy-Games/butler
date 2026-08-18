import type { RuntimeTurnEventInput } from "../../../../agent/events/turn-events.ts";
import type {
  MessageRecord,
  ProgressSummaryRow,
  TurnRecord,
} from "../../interface/protocol/app-protocol.ts";
import {
  appSafeResponderError,
} from "../../infrastructure/transport/failure-ux-contract.ts";
import { publicDeliveryMetadataForProjection } from "../../infrastructure/transport/btcc-public-projection.ts";
import type {
  AppMessageResponder,
  AppMessageResponderResult,
  SendMessageOptions,
} from "./message-responder-contract.ts";

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
  queuedMessageId?: string;
  queueClaimId?: string;
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
  updateTurnFailed(
    chatId: string,
    turnId: string,
    safeError: { code: string; message: string; cause?: string },
  ): TurnRecord;
  runInTransaction<T>(callback: () => T): T;
  fenceQueuedTurnClaim(input: {
    chatId: string;
    turnId: string;
    claimId: string;
  }): boolean;
  acknowledgeQueuedMessageForTurn(input: {
    chatId: string;
    turnId: string;
    claimId: string;
    resultMessageId?: string;
    safeErrorCode?: string | null;
  }): boolean;
  terminalResultMessageIdForTurn(chatId: string, turnId: string): string | undefined;
  assertQueueClaim?: () => void;
}

export async function completeResponderTurn<FileRecord>(
  input: CompleteResponderTurnInput,
  context: CompleteResponderTurnContext<FileRecord>,
): Promise<CompletedResponderTurnResult> {
  const hasQueuedClaim = Boolean(input.queuedMessageId && input.queueClaimId);
  const onProgress = hasQueuedClaim
    ? (row: ProgressSummaryInput) => {
        runClaimedResponderMutation(input, context, () => {
          context.appendProgress(row);
        });
      }
    : context.appendProgress;
  const onTurnEvent = hasQueuedClaim
    ? (event: RuntimeTurnEventInput) => {
        runClaimedResponderMutation(input, context, () => {
          context.appendTurnEvent(event);
        });
      }
    : context.appendTurnEvent;
  try {
    const response = await context.runResponder(
      input.chatId,
      input.turnId,
      input.messageId,
      input.text,
      input.responder,
      input.options,
      onProgress,
      onTurnEvent,
    );
    context.assertQueueClaim?.();
    const limitedDelivery = response.delivery?.delivery_state === "delivered_with_limitations" ||
      response.delivery?.delivery_state === "delivered_with_continuation"
      ? response.delivery
      : null;
    const committed = runClaimedResponderMutation(input, context, () => {
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
      acknowledgeClaimedResponderTurn(input, context, replies.at(-1)?.id);
      return { replies, deliveredTurn };
    });
    await context.drainQueuedSessionMessages(
      input.chatId,
      input.responder,
      input.options,
    );

    const publicLimitedDelivery = limitedDelivery
      ? publicDeliveryMetadataForProjection(limitedDelivery)
      : null;
    const projectedReplies = publicLimitedDelivery
      ? committed.replies.map((reply) => ({ ...reply, ...publicLimitedDelivery }))
      : committed.replies;
    const reply = projectedReplies.at(-1)!;
    return {
      reply,
      replies: projectedReplies,
      turn: committed.deliveredTurn,
      next_cursor: reply.cursor,
    };
  } catch (error) {
    if (isQueueClaimLostError(error)) throw error;
    if (isResponderCancelError(error)) {
      const cancelledTurn = runClaimedResponderMutation(input, context, () => {
        const cancelled = context.finalizeCancelledTurn(
          input.chatId,
          input.turnId,
        );
        acknowledgeClaimedResponderTurn(input, context, undefined, "turn_cancelled");
        return cancelled;
      });
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
    const safeError = appSafeResponderError(error);
    const failedTurn = runClaimedResponderMutation(input, context, () => {
      const failed = context.updateTurnFailed(
        input.chatId,
        input.turnId,
        safeError,
      );
      context.touchChat(input.chatId);
      acknowledgeClaimedResponderTurn(
        input,
        context,
        context.terminalResultMessageIdForTurn(input.chatId, input.turnId),
        failed.safe_error_code ?? safeError.code,
      );
      return failed;
    });
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

function runClaimedResponderMutation<T, FileRecord>(
  input: CompleteResponderTurnInput,
  context: CompleteResponderTurnContext<FileRecord>,
  mutation: () => T,
): T {
  if (!input.queuedMessageId || !input.queueClaimId) return mutation();
  return context.runInTransaction(() => {
    if (!context.fenceQueuedTurnClaim({
      chatId: input.chatId,
      turnId: input.turnId,
      claimId: input.queueClaimId!,
    })) throw new Error("queued_message_claim_lost");
    return mutation();
  });
}

function acknowledgeClaimedResponderTurn<FileRecord>(
  input: CompleteResponderTurnInput,
  context: CompleteResponderTurnContext<FileRecord>,
  resultMessageId?: string,
  safeErrorCode?: string,
): void {
  if (!input.queuedMessageId || !input.queueClaimId) return;
  if (!context.acknowledgeQueuedMessageForTurn({
    chatId: input.chatId,
    turnId: input.turnId,
    claimId: input.queueClaimId,
    ...(resultMessageId ? { resultMessageId } : {}),
    ...(safeErrorCode ? { safeErrorCode } : {}),
  })) throw new Error("queued_message_claim_lost");
}

function isQueueClaimLostError(error: unknown): boolean {
  return error instanceof Error && error.message === "queued_message_claim_lost";
}

export function isResponderCancelError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as { code?: unknown; name?: unknown };
  return record.code === "turn_cancelled" ||
    record.name === "AppResponderCancelledError";
}
