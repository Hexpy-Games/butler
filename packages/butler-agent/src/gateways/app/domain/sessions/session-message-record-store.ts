import { Database } from "bun:sqlite";
import { readCompactionSnapshots } from "../../../../agent/context/compaction.ts";
import type { MessageRow } from "../../infrastructure/core/records.ts";
import { AppStoreOperationError } from "../../infrastructure/core/app-store-errors.ts";
import { messageFromRow } from "./message-read-model.ts";
import type {
  AppMessageFileStore,
  MessageFileRow,
} from "../message-files/message-file-store.ts";
import type {
  MessageRecord,
  MessageRole,
  MessageStatus,
} from "../../interface/protocol/app-protocol.ts";
import { sessionHintForRow } from "./session-read-model.ts";
import { visibleMessageSqlPredicate } from "./visible-message-sql.ts";

export class AppSessionMessageRecordStore {
  constructor(
    private readonly db: Database,
    private readonly butlerData: string,
    private readonly messageFiles: AppMessageFileStore,
    private readonly ensureChat: (chatId: string) => void,
  ) {}

  listMessages(chatId: string, cursor = 0): MessageRecord[] {
    this.ensureChat(chatId);
    const rows = this.db
      .query<MessageRow, [string, number]>(
        `
      SELECT rowid, id, chat_id, turn_id, conversation_session_id, conversation_turn_id,
        conversation_message_id, role, text, status, created_at, updated_at, safe_error_code, retryable
      FROM messages
      WHERE chat_id = ? AND rowid > ? AND ${visibleMessageSqlPredicate()}
      ORDER BY rowid ASC
      LIMIT 200
    `,
      )
      .all(chatId, cursor);
    const messages = rows.map((row) =>
      messageFromRow(row, this.messageFiles.refsForMessage(row.id)),
    );
    const compactionMessages =
      cursor === 0 ? this.compactionMarkerMessages(chatId, cursor) : [];
    return [...messages, ...compactionMessages]
      .filter((message) => Number(message.cursor ?? 0) > cursor)
      .sort(
        (left, right) => Number(left.cursor ?? 0) - Number(right.cursor ?? 0),
      )
      .slice(0, 200);
  }

  getMessageRow(messageId: string): MessageRow | null {
    return (
      this.db
        .query<MessageRow, [string]>(
          `
      SELECT rowid, id, chat_id, turn_id, conversation_session_id, conversation_turn_id,
        conversation_message_id, role, text, status, created_at, updated_at, safe_error_code, retryable
      FROM messages
      WHERE id = ?
    `,
        )
        .get(messageId) ?? null
    );
  }

  messageRecordById(messageId: string): MessageRecord {
    const row = this.getMessageRow(messageId);
    if (!row) {
      throw new AppStoreOperationError(
        404,
        "message_not_found",
        "Message not found.",
      );
    }
    return messageFromRow(row, this.messageFiles.refsForMessage(messageId));
  }

  getLatestAssistantMessageForTurn(turnId: string): MessageRow | null {
    return (
      this.db
        .query<MessageRow, [string]>(
          `
      SELECT rowid, id, chat_id, turn_id, conversation_session_id, conversation_turn_id,
        conversation_message_id, role, text, status, created_at, updated_at, safe_error_code, retryable
      FROM messages
      WHERE turn_id = ? AND role = 'assistant'
      ORDER BY rowid DESC
      LIMIT 1
    `,
        )
        .get(turnId) ?? null
    );
  }

  insertMessage(
    chatId: string,
    role: MessageRole,
    text: string,
    status: MessageStatus,
    options: {
      clientMessageId?: string;
      turnId?: string;
      safeErrorCode?: string;
      retryable?: boolean;
      attachments?: MessageFileRow[];
      conversationSessionId?: string | null;
      conversationTurnId?: string | null;
      conversationMessageId?: string | null;
    } = {},
  ): MessageRecord {
    const safeClientId = options.clientMessageId?.trim();
    const id =
      role === "user" &&
      safeClientId &&
      /^client-[0-9a-f-]{36}$/iu.test(safeClientId)
        ? safeClientId
        : `msg-${crypto.randomUUID()}`;
    const createdAt = new Date().toISOString();
    this.db
      .query(
        `
      INSERT INTO messages (
        id, chat_id, turn_id, conversation_session_id, conversation_turn_id,
        conversation_message_id, role, text, status, created_at, updated_at,
        safe_error_code, retryable
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        id,
        chatId,
        options.turnId ?? null,
        options.conversationSessionId ?? null,
        options.conversationTurnId ?? null,
        options.conversationMessageId ?? null,
        role,
        text,
        status,
        createdAt,
        createdAt,
        options.safeErrorCode ?? null,
        options.retryable ? 1 : 0,
      );
    if (options.attachments?.length) {
      this.messageFiles.attachToMessage(chatId, id, options.attachments);
    }
    const row = this.getMessageRow(id);
    if (!row) throw new Error(`Failed to insert message: ${id}`);
    return messageFromRow(row, this.messageFiles.refsForMessage(id));
  }

  updateMessage(
    messageId: string,
    input: {
      text?: string;
      status?: MessageStatus;
      safeErrorCode?: string | null;
      retryable?: boolean;
    },
  ): MessageRecord {
    const current = this.getMessageRow(messageId);
    if (!current) {
      throw new AppStoreOperationError(
        404,
        "message_not_found",
        "Message not found.",
      );
    }
    const now = new Date().toISOString();
    this.db
      .query(
        `
      UPDATE messages
      SET text = ?, status = ?, updated_at = ?, safe_error_code = ?, retryable = ?
      WHERE id = ?
    `,
      )
      .run(
        input.text ?? current.text,
        input.status ?? current.status,
        now,
        input.safeErrorCode === undefined
          ? current.safe_error_code
          : input.safeErrorCode,
        input.retryable === undefined
          ? current.retryable
          : input.retryable
            ? 1
            : 0,
        messageId,
      );
    const row = this.getMessageRow(messageId);
    if (!row) throw new Error(`Failed to update message: ${messageId}`);
    return messageFromRow(row, this.messageFiles.refsForMessage(messageId));
  }

  touchChat(chatId: string): void {
    const now = new Date().toISOString();
    this.db
      .query("UPDATE chats SET updated_at = ? WHERE id = ?")
      .run(now, chatId);
  }

  private compactionMarkerMessages(
    chatId: string,
    cursor: number,
  ): MessageRecord[] {
    const snapshots = readCompactionSnapshots({
      butlerData: this.butlerData,
      sessionId: sessionHintForRow(chatId),
    }).filter((snapshot) => snapshot.status === "ok");
    if (snapshots.length === 0) return [];
    const messageTimeline = this.db
      .query<{ rowid: number; created_at: string }, [string]>(
        `
      SELECT rowid, created_at
      FROM messages
      WHERE chat_id = ?
      ORDER BY rowid ASC
    `,
      )
      .all(chatId);
    return snapshots.flatMap((snapshot) => {
      const previous = [...messageTimeline]
        .reverse()
        .find((row) => row.created_at <= snapshot.created_at);
      const markerCursor = Number(previous?.rowid ?? 0) + 0.25;
      if (markerCursor <= cursor) return [];
      const completedMs = Date.parse(snapshot.created_at);
      const startedAt = new Date(
        Number.isFinite(completedMs)
          ? Math.max(0, completedMs - 1)
          : Date.now(),
      ).toISOString();
      return [
        {
          id: `system-compaction-started-${snapshot.snapshot_id}`,
          chat_id: chatId,
          role: "system_event",
          text: "Context automatically compacting",
          status: "delivered",
          retryable: false,
          cursor: markerCursor,
          created_at: startedAt,
          updated_at: startedAt,
        },
        {
          id: `system-compaction-completed-${snapshot.snapshot_id}`,
          chat_id: chatId,
          role: "system_event",
          text: "Context automatically compacted",
          status: "delivered",
          retryable: false,
          cursor: markerCursor + 0.01,
          created_at: snapshot.created_at,
          updated_at: snapshot.created_at,
        },
      ];
    });
  }
}
