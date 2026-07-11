import { Database } from "bun:sqlite";
import { AppStoreOperationError } from "../../infrastructure/core/app-store-errors.ts";
import { CANCELLED_TURN_ACTIVITY_TEXT } from "./cancelled-turn-activity.ts";
import { messageFromRow } from "./message-read-model.ts";
import type { MessageRow, TurnRow } from "../../infrastructure/core/records.ts";
import type {
  MessageRecord,
  MessageFileRef,
  SessionControlState,
  TurnActionResult,
  TurnRecord,
  TurnState,
} from "../../interface/protocol/app-protocol.ts";
import type {
  AppMessageResponder,
  SendMessageOptions,
} from "./message-responder-contract.ts";

interface TurnActionStoreInput {
  db: Database;
  getTurn: (turnId: string) => TurnRecord;
  getTurnRow: (turnId: string) => TurnRow | null;
  runtimeFaultRecordForTurn: (turnId: string) => Record<string, unknown> | null;
  getMessageRow: (messageId: string) => MessageRow | null;
  refsForMessage: (messageId: string) => MessageFileRef[];
  claimRetryTurn: (turnId: string, attempt: number) => TurnRecord;
  appendEvent: (type: string, payload: Record<string, unknown>) => void;
  deleteAssistantMessagesForTurn: (turnId: string) => void;
  enqueueAppTransportTurn: (input: {
    chatId: string;
    turnId: string;
    message: MessageRecord;
    text: string;
    controls: SessionControlState;
  }) => TurnRecord;
  getSessionControls: (sessionId: string) => SessionControlState;
  dispatchDeferredResponderTurn: (input: {
    chatId: string;
    turnId: string;
    messageId: string;
    text: string;
    responder: AppMessageResponder;
    options: SendMessageOptions;
  }) => void;
  completeResponderTurn: (input: {
    chatId: string;
    turnId: string;
    messageId: string;
    text: string;
    responder: AppMessageResponder;
    options: SendMessageOptions;
  }) => Promise<TurnActionResult>;
  cancelResponder: (turnId: string) => void;
  cancelPersistedRuntimeTurn: (turnId: string) => void;
  finalizeCancelledTurn: (chatId: string, turnId: string) => TurnRecord;
  cleanupTurnEventSequences: (chatId: string, turnId: string) => void;
  ensureCancelledTurnActivityMessage: (
    chatId: string,
    turnId: string,
  ) => MessageRecord | null;
}

export class AppTurnActionStore {
  constructor(private readonly input: TurnActionStoreInput) {}

  async retryTurn(
    turnId: string,
    responder?: AppMessageResponder,
    options: SendMessageOptions = {},
  ): Promise<TurnActionResult> {
    const row = this.retryableTurnRow(turnId);
    const userMessage = this.userMessageForRetry(row);
    const retryingTurn = this.input.claimRetryTurn(turnId, row.attempt + 1);
    this.input.appendEvent("turn.state_changed", { turn: retryingTurn });
    this.input.deleteAssistantMessagesForTurn(turnId);

    if (!responder) {
      this.input.enqueueAppTransportTurn({
        chatId: row.chat_id,
        turnId,
        message: messageFromRow(
          userMessage,
          this.input.refsForMessage(userMessage.id),
        ),
        text: userMessage.text,
        controls: this.input.getSessionControls(row.chat_id),
      });
      return {
        turn: retryingTurn,
        replies: [],
        next_cursor: retryingTurn.cursor,
      };
    }

    const responderOptions = {
      ...options,
      controls: this.input.getSessionControls(row.chat_id),
    };
    if (options.deferResponderTurns) {
      this.input.dispatchDeferredResponderTurn({
        chatId: row.chat_id,
        turnId,
        messageId: userMessage.id,
        text: userMessage.text,
        responder,
        options: responderOptions,
      });
      return {
        turn: retryingTurn,
        replies: [],
        next_cursor: retryingTurn.cursor,
      };
    }

    return await this.input.completeResponderTurn({
      chatId: row.chat_id,
      turnId,
      messageId: userMessage.id,
      text: userMessage.text,
      responder,
      options: responderOptions,
    });
  }

  cancelTurn(turnId: string): TurnActionResult {
    const row = this.input.getTurnRow(turnId);
    if (!row) {
      throw new AppStoreOperationError(
        404,
        "turn_not_found",
        "Turn not found.",
      );
    }
    if (
      !row.cancellable ||
      ["cancelled", "delivered", "failed"].includes(row.state)
    ) {
      throw new AppStoreOperationError(
        409,
        "turn_not_cancellable",
        "Turn is not cancellable.",
      );
    }
    this.input.cancelResponder(turnId);
    this.input.cancelPersistedRuntimeTurn(turnId);
    const cancelledTurn = this.input.finalizeCancelledTurn(row.chat_id, turnId);
    this.input.cleanupTurnEventSequences(row.chat_id, turnId);
    return {
      turn: cancelledTurn,
      replies: [],
      next_cursor: 0,
    };
  }

  sessionHasActiveTurn(sessionId: string): boolean {
    this.reconcileDeliveredSystemResponderTurns(sessionId);
    const row = this.input.db
      .query<{ state: TurnState }, [string]>(
        `
      SELECT state
      FROM turns
      WHERE chat_id = ?
      ORDER BY rowid DESC
      LIMIT 1
    `,
      )
      .get(sessionId);
    return Boolean(
      row &&
        [
          "accepted",
          "thinking",
          "streaming",
          "waiting_for_form",
          "waiting_for_tool",
          "cancelling",
          "retrying",
        ].includes(row.state),
    );
  }

  reconcileDeliveredSystemResponderTurns(sessionId: string): void {
    const now = new Date().toISOString();
    this.input.db
      .query<unknown, [string, string]>(
        `
      UPDATE turns
      SET
        state = 'delivered',
        safe_status_label = 'Delivered',
        safe_error_code = NULL,
        retryable = 0,
        cancellable = 0,
        updated_at = ?
      WHERE chat_id = ?
        AND user_message_id IS NULL
        AND state IN ('accepted', 'thinking', 'streaming', 'waiting_for_form', 'waiting_for_tool', 'cancelling', 'retrying')
        AND EXISTS (
          SELECT 1
          FROM messages
          WHERE messages.chat_id = turns.chat_id
            AND messages.role = 'assistant'
            AND messages.status = 'delivered'
            AND messages.turn_id IS NULL
            AND messages.created_at >= turns.created_at
        )
    `,
      )
      .run(now, sessionId);
  }

  reconcileCancelledTurnActivityMessages(): void {
    const rows = this.input.db
      .query<{ id: string; chat_id: string }, [string]>(
        `
      SELECT turns.id, turns.chat_id
      FROM turns
      WHERE turns.state = 'cancelled'
        AND NOT EXISTS (
          SELECT 1
          FROM messages
          WHERE messages.turn_id = turns.id
            AND messages.role = 'assistant'
            AND messages.status = 'cancelled'
            AND messages.text = ?
        )
      ORDER BY turns.rowid ASC
    `,
      )
      .all(CANCELLED_TURN_ACTIVITY_TEXT);
    for (const row of rows) {
      this.input.ensureCancelledTurnActivityMessage(row.chat_id, row.id);
    }
  }

  private retryableTurnRow(turnId: string): TurnRow {
    const row = this.input.getTurnRow(turnId);
    if (!row) {
      throw new AppStoreOperationError(
        404,
        "turn_not_found",
        "Turn not found.",
      );
    }
    if (
      !row.retryable ||
      row.state !== "runtime_fault" ||
      this.input.runtimeFaultRecordForTurn(turnId)?.retryable !== true
    ) {
      throw new AppStoreOperationError(
        409,
        "turn_not_retryable",
        "Turn is not retryable.",
      );
    }
    return row;
  }

  private userMessageForRetry(row: TurnRow): MessageRow {
    if (!row.user_message_id) {
      throw new AppStoreOperationError(
        409,
        "turn_missing_user_message",
        "Turn cannot be retried.",
      );
    }
    const userMessage = this.input.getMessageRow(row.user_message_id);
    if (!userMessage) {
      throw new AppStoreOperationError(
        409,
        "turn_missing_user_message",
        "Turn cannot be retried.",
      );
    }
    return userMessage;
  }
}
