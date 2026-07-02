import { Database } from "bun:sqlite";
import {
  CANCELLED_TURN_ACTIVITY_TEXT,
  isCancelledTurnActivityCarrier,
} from "./cancelled-turn-activity.ts";
import type { AppMessageFileStore, MessageFileRow } from "../message-files/message-file-store.ts";
import type { MessageRow } from "../../infrastructure/core/records.ts";
import type {
  MessageRecord,
  MessageRole,
  MessageStatus,
} from "../../interface/protocol/app-protocol.ts";

export class AppAssistantMessageStore {
  constructor(
    private readonly input: {
      db: Database;
      messageFiles: AppMessageFileStore;
      insertMessage: (
        chatId: string,
        role: MessageRole,
        text: string,
        status: MessageStatus,
        options?: {
          clientMessageId?: string;
          turnId?: string;
          safeErrorCode?: string;
          retryable?: boolean;
          attachments?: MessageFileRow[];
        },
      ) => MessageRecord;
      updateMessage: (
        messageId: string,
        input: {
          text?: string;
          status?: MessageStatus;
          safeErrorCode?: string | null;
          retryable?: boolean;
        },
      ) => MessageRecord;
      messageRecordById: (messageId: string) => MessageRecord;
      getLatestAssistantMessageForTurn: (turnId: string) => MessageRow | null;
      listMessages: (chatId: string) => MessageRecord[];
      messageWithTerminalWorkBlocks: (
        message: MessageRecord,
        turnId: string,
      ) => MessageRecord;
      appendEvent: (type: string, payload: Record<string, unknown>) => void;
    },
  ) {}

  insertReplies(
    chatId: string,
    turnId: string,
    texts: string[],
    files: MessageFileRow[] = [],
  ): MessageRecord[] {
    return normalizedAssistantReplyTexts(texts, files).map(
      (replyText, index, normalizedReplies) => {
        const reply = this.input.insertMessage(
          chatId,
          "assistant",
          replyText,
          "delivered",
          {
            turnId,
            attachments: index === normalizedReplies.length - 1 ? files : [],
          },
        );
        this.input.appendEvent("message.created", { message: reply });
        return reply;
      },
    );
  }

  insertOrReplaceReplies(
    chatId: string,
    turnId: string,
    texts: string[],
    files: MessageFileRow[] = [],
  ): MessageRecord[] {
    const normalizedReplies = normalizedAssistantReplyTexts(texts, files);
    const existing = this.input.getLatestAssistantMessageForTurn(turnId);
    if (!existing) return this.insertReplies(chatId, turnId, normalizedReplies, files);

    const [firstReply, ...remainingReplies] = normalizedReplies;
    const attachFilesToUpdated = remainingReplies.length === 0 ? files : [];
    let updated = this.input.updateMessage(existing.id, {
      text: firstReply ?? "Butler did not return a visible reply.",
      status: "delivered",
      safeErrorCode: null,
      retryable: false,
    });
    if (attachFilesToUpdated.length > 0) {
      this.input.messageFiles.attachToMessage(
        chatId,
        updated.id,
        attachFilesToUpdated,
      );
      updated = this.input.messageRecordById(updated.id);
    }
    this.input.appendEvent("message.updated", { message: updated });
    if (remainingReplies.length === 0) return [updated];
    return [
      updated,
      ...this.insertReplies(chatId, turnId, remainingReplies, files),
    ];
  }

  deleteForTurn(turnId: string): void {
    const rows = this.input.db
      .query<MessageRow, [string]>(
        `
      SELECT rowid, id, chat_id, turn_id, conversation_session_id, conversation_turn_id,
        conversation_message_id, role, text, status, created_at, updated_at, safe_error_code, retryable
      FROM messages
      WHERE turn_id = ? AND role = 'assistant'
      ORDER BY rowid DESC
    `,
      )
      .all(turnId);
    for (const row of rows) {
      this.input.db
        .query(
          `
        UPDATE message_files
        SET message_id = NULL
        WHERE message_id = ?
      `,
        )
        .run(row.id);
      this.input.db
        .query(
          `
        DELETE FROM message_attachments
        WHERE message_id = ?
      `,
        )
        .run(row.id);
      this.input.db.query("DELETE FROM messages WHERE id = ?").run(row.id);
      this.input.appendEvent("message.deleted", {
        message_id: row.id,
        chat_id: row.chat_id,
        turn_id: row.turn_id,
        role: row.role,
      });
    }
  }

  upsertTurnFailure(
    chatId: string,
    turnId: string,
    safeError: { code: string; message: string },
    options: { retryable?: boolean } = {},
  ): MessageRecord {
    const existing = this.input.getLatestAssistantMessageForTurn(turnId);
    if (!existing) {
      const failed = this.input.insertMessage(
        chatId,
        "assistant",
        safeError.message,
        "failed",
        {
          turnId,
          safeErrorCode: safeError.code,
          retryable: options.retryable ?? false,
        },
      );
      this.input.appendEvent("message.created", { message: failed });
      return failed;
    }
    const failed = this.input.updateMessage(existing.id, {
      text: safeError.message,
      status: "failed",
      safeErrorCode: safeError.code,
      retryable: options.retryable ?? false,
    });
    this.input.appendEvent("message.updated", { message: failed });
    return failed;
  }

  ensureCancelledTurnActivity(
    chatId: string,
    turnId: string,
  ): MessageRecord | null {
    const existingAssistant = this.input.listMessages(chatId).find(
      (message) => message.role === "assistant" && message.turn_id === turnId,
    );
    if (existingAssistant && isCancelledTurnActivityCarrier(existingAssistant)) {
      return null;
    }
    if (existingAssistant) this.deleteForTurn(turnId);
    const message = this.input.insertMessage(
      chatId,
      "assistant",
      CANCELLED_TURN_ACTIVITY_TEXT,
      "cancelled",
      { turnId },
    );
    const projected = this.input.messageWithTerminalWorkBlocks(message, turnId);
    this.input.appendEvent("message.created", { message: projected });
    return projected;
  }
}

function normalizedAssistantReplyTexts(
  texts: string[],
  files: MessageFileRow[],
): string[] {
  const replyTexts = texts.map((item) => item.trim()).filter(Boolean);
  if (replyTexts.length > 0) return replyTexts;
  if (files.length > 0) return ["Butler attached a file."];
  return ["Butler did not return a visible reply."];
}
