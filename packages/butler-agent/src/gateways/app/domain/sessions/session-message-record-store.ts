import { Database } from "bun:sqlite";
import { readCompactionSnapshots } from "../../../../agent/context/compaction.ts";
import type { MessageRow } from "../../infrastructure/core/records.ts";
import { AppStoreOperationError } from "../../infrastructure/core/app-store-errors.ts";
import {
  artifactSummaryFromRow,
  messageFromRow,
  type SessionArtifactReadModelRow,
} from "./message-read-model.ts";
import type {
  AppMessageFileStore,
  MessageFileRow,
} from "../message-files/message-file-store.ts";
import type {
  MessageRecord,
  MessageRole,
  MessageStatus,
  SessionArtifactSummary,
} from "../../interface/protocol/app-protocol.ts";
import { sessionHintForRow } from "./session-read-model.ts";
import { visibleMessageSqlPredicate } from "./visible-message-sql.ts";
import {
  normalizeSessionMessagePageOptions,
  type SessionMessagePage,
  type SessionMessagePageOptions,
} from "./session-message-page.ts";
import type { ChangedFileDetail, ChangedFileLine } from "../../../../agent/tools/file-tools/shared/changed-file-detail.ts";

export class AppSessionMessageRecordStore {
  constructor(
    private readonly db: Database,
    private readonly butlerData: string,
    private readonly messageFiles: AppMessageFileStore,
    private readonly ensureChat: (chatId: string) => void,
  ) {}

  listMessages(
    chatId: string,
    cursorOrOptions: number | SessionMessagePageOptions = 0,
  ): MessageRecord[] {
    return this.listMessagePage(chatId, cursorOrOptions).items;
  }

  listMessagePage(
    chatId: string,
    cursorOrOptions: number | SessionMessagePageOptions = 0,
  ): SessionMessagePage<MessageRecord> {
    this.ensureChat(chatId);
    const options = normalizeSessionMessagePageOptions(
      typeof cursorOrOptions === "number"
        ? { afterCursor: cursorOrOptions }
        : cursorOrOptions,
    );
    const beforeCursor = options.beforeCursor;
    const afterCursor = options.fromBeginning ? 0 : options.afterCursor;
    const queryLimit = options.limit + 1;
    const query = beforeCursor !== undefined
      ? `
      SELECT rowid, id, chat_id, turn_id, conversation_session_id, conversation_turn_id,
        conversation_message_id, role, text, status, created_at, updated_at, safe_error_code, retryable
      FROM messages
      WHERE chat_id = ?
        AND rowid < ?
        AND ${visibleMessageSqlPredicate()}
      ORDER BY rowid DESC
      LIMIT ${queryLimit}
    `
      : afterCursor !== undefined
        ? `
      SELECT rowid, id, chat_id, turn_id, conversation_session_id, conversation_turn_id,
        conversation_message_id, role, text, status, created_at, updated_at, safe_error_code, retryable
      FROM messages
      WHERE chat_id = ?
        AND rowid > ?
        AND ${visibleMessageSqlPredicate()}
      ORDER BY rowid ASC
      LIMIT ${queryLimit}
    `
        : `
      SELECT rowid, id, chat_id, turn_id, conversation_session_id, conversation_turn_id,
        conversation_message_id, role, text, status, created_at, updated_at, safe_error_code, retryable
      FROM messages
      WHERE chat_id = ?
        AND ${visibleMessageSqlPredicate()}
      ORDER BY rowid DESC
      LIMIT ${queryLimit}
    `;
    const statement = this.db.query<MessageRow, any>(query);
    const rows =
      beforeCursor === undefined && afterCursor === undefined
        ? statement.all(chatId)
        : statement.all(chatId, beforeCursor ?? afterCursor!);
    const hasMoreRows = rows.length > options.limit;
    const pageRows =
      beforeCursor !== undefined || afterCursor === undefined
        ? rows.slice(0, options.limit).reverse()
        : rows.slice(0, options.limit);
    const attachmentsByMessage = this.messageFiles.refsForMessages(
      pageRows.map((row) => row.id),
    );
    const changedFilesByMessage = this.changedFilesForMessages(
      pageRows.map((row) => row.id),
    );
    const messages = pageRows.map((row) =>
      messageFromRow(
        row,
        attachmentsByMessage.get(row.id) ?? [],
        changedFilesByMessage.get(row.id) ?? [],
      ),
    );
    const compactionMessages =
      beforeCursor === undefined && afterCursor === undefined
        ? this.compactionMarkerMessages(chatId, 0)
        : [];
    const ordered = [...messages, ...compactionMessages]
      .filter((message) =>
        beforeCursor === undefined
          ? afterCursor === undefined || Number(message.cursor ?? 0) > afterCursor
          : Number(message.cursor ?? 0) < beforeCursor,
      )
      .sort(
        (left, right) => Number(left.cursor ?? 0) - Number(right.cursor ?? 0),
      );
    // The initial page is a latest window. Compaction markers are a bounded
    // presentation aid and must never displace the newest canonical messages
    // or move the delta cursor backwards. When the canonical page is full,
    // markers wait for a later page instead of evicting a real row.
    const page = beforeCursor === undefined && afterCursor === undefined
      ? messages.length >= options.limit
        ? messages
        : [
          ...messages,
          ...compactionMessages
            .slice(-(options.limit - messages.length)),
        ].sort(
          (left, right) => Number(left.cursor ?? 0) - Number(right.cursor ?? 0),
        )
      : ordered.slice(0, options.limit);
    const firstCursor = Number(page[0]?.cursor ?? 0);
    const lastCursor = Number(page.at(-1)?.cursor ?? 0);
    return {
      items: page,
      nextCursor: lastCursor || afterCursor || 0,
      previousCursor: firstCursor > 0 ? firstCursor : null,
      hasMore: hasMoreRows,
    };
  }

  latestMessageRevision(chatId: string): string {
    this.ensureChat(chatId);
    const row = this.db
      .query<{ recent_revision: string | null }, [string]>(`
        SELECT GROUP_CONCAT(rowid || ':' || updated_at, '|') AS recent_revision
        FROM (
          SELECT rowid, updated_at
          FROM messages
          WHERE chat_id = ?
            AND ${visibleMessageSqlPredicate()}
          ORDER BY rowid DESC
          LIMIT 16
        )
      `)
      .get(chatId);
    return row?.recent_revision ?? "";
  }

  /**
   * Read the public artifact projection from the latest bounded message
   * window without constructing message text, progress, or attachment maps.
   * The order/limit mirrors `listMessages(...).flatMap(...).slice(-20)`:
   * newest message/attachment rows are selected first, then reversed into
   * the canonical chronological artifact order.
   */
  listArtifactSummaries(chatId: string): SessionArtifactSummary[] {
    this.ensureChat(chatId);
    const rows = this.db
      .query<SessionArtifactReadModelRow, [string]>(`
        WITH latest_messages AS (
          SELECT rowid, id, chat_id, turn_id, role, safe_error_code
          FROM messages AS m
          WHERE m.chat_id = ?
            AND ${visibleMessageSqlPredicate("m")}
          ORDER BY rowid DESC
          LIMIT 200
        )
        SELECT
          m.rowid AS message_rowid,
          m.id AS message_id,
          m.chat_id,
          m.turn_id,
          f.id,
          f.owner_session_id,
          f.kind,
          f.mime_type,
          f.safe_name,
          f.size_bytes,
          f.sha256,
          f.storage_name,
          f.created_at
        FROM latest_messages AS m
        JOIN message_attachments AS a ON a.message_id = m.id
        JOIN message_files AS f ON f.id = a.file_id
        WHERE m.role = 'assistant'
        ORDER BY m.rowid DESC, a.position DESC
        LIMIT 20
      `)
      .all(chatId);
    return rows.reverse().map(artifactSummaryFromRow);
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
    return messageFromRow(
      row,
      this.messageFiles.refsForMessage(messageId),
      this.changedFilesForMessages([messageId]).get(messageId) ?? [],
    );
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
    return messageFromRow(
      row,
      this.messageFiles.refsForMessage(messageId),
      this.changedFilesForMessages([messageId]).get(messageId) ?? [],
    );
  }

  replaceMessageChangedFiles(
    messageId: string,
    details: readonly (ChangedFileDetail | string)[],
  ): MessageRecord {
    const byPath = new Map<string, ChangedFileDetail>();
    for (const detail of details.flatMap(normalizeChangedFile)) {
      const existing = byPath.get(detail.path);
      if (!existing || existing.lines.length === 0 || detail.lines.length > 0) {
        byPath.set(detail.path, detail);
      }
    }
    const normalized = [...byPath.values()].slice(0, 40);
    this.db.transaction(() => {
      this.db.query("DELETE FROM message_changed_files WHERE message_id = ?")
        .run(messageId);
      const insert = this.db.query(`
        INSERT INTO message_changed_files (message_id, position, safe_path_label, detail_json)
        VALUES (?, ?, ?, ?)
      `);
      normalized.forEach((detail, position) => insert.run(
        messageId,
        position,
        detail.path,
        detail.lines.length > 0 || detail.additions > 0 || detail.deletions > 0
          ? JSON.stringify(detail)
          : null,
      ));
    })();
    return this.messageRecordById(messageId);
  }

  touchChat(chatId: string): void {
    const now = new Date().toISOString();
    this.db
      .query("UPDATE chats SET updated_at = ? WHERE id = ?")
      .run(now, chatId);
  }

  private changedFilesForMessages(
    messageIds: readonly string[],
  ): Map<string, ChangedFileDetail[]> {
    const result = new Map<string, ChangedFileDetail[]>();
    if (messageIds.length === 0) return result;
    const placeholders = messageIds.map(() => "?").join(", ");
    const rows = this.db.query<{
      message_id: string;
      safe_path_label: string;
      detail_json: string | null;
    }, string[]>(`
      SELECT message_id, safe_path_label, detail_json
      FROM message_changed_files
      WHERE message_id IN (${placeholders})
      ORDER BY message_id ASC, position ASC
    `).all(...messageIds);
    for (const row of rows) {
      const details = result.get(row.message_id) ?? [];
      details.push(parseChangedFileDetail(row.detail_json, row.safe_path_label));
      result.set(row.message_id, details);
    }
    return result;
  }

  private compactionMarkerMessages(
    chatId: string,
    cursor: number,
  ): MessageRecord[] {
    const snapshots = readCompactionSnapshots({
      butlerData: this.butlerData,
      sessionId: sessionHintForRow(chatId),
    })
      .filter((snapshot) => snapshot.status === "ok")
      // Markers are a bounded presentation aid, not a second transcript. The
      // canonical compaction records remain on disk for recovery/export.
      .slice(-32);
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

function normalizeChangedFile(value: ChangedFileDetail | string): ChangedFileDetail[] {
  if (typeof value === "string") {
    const path = safeChangedFilePath(value);
    return path ? [{ path, additions: 0, deletions: 0, lines: [] }] : [];
  }
  const path = safeChangedFilePath(value.path);
  if (!path || !Array.isArray(value.lines)) return [];
  const lines = value.lines.flatMap(normalizeChangedFileLine);
  return [{
    path,
    additions: lines.filter((line) => line.type === "added").length,
    deletions: lines.filter((line) => line.type === "deleted").length,
    lines,
  }];
}

function normalizeChangedFileLine(value: ChangedFileLine): ChangedFileLine[] {
  if ((value.type !== "added" && value.type !== "deleted") || typeof value.content !== "string") return [];
  const oldLine = value.old_line;
  const newLine = value.new_line;
  if (oldLine !== undefined && (!Number.isSafeInteger(oldLine) || oldLine < 1)) return [];
  if (newLine !== undefined && (!Number.isSafeInteger(newLine) || newLine < 1)) return [];
  return [{
    type: value.type,
    ...(oldLine === undefined ? {} : { old_line: oldLine }),
    ...(newLine === undefined ? {} : { new_line: newLine }),
    content: value.content,
  }];
}

function parseChangedFileDetail(value: string | null, fallbackPath: string): ChangedFileDetail {
  if (!value) return { path: fallbackPath, additions: 0, deletions: 0, lines: [] };
  try {
    const parsed = JSON.parse(value) as ChangedFileDetail;
    return normalizeChangedFile(parsed)[0] ?? {
      path: fallbackPath,
      additions: 0,
      deletions: 0,
      lines: [],
    };
  } catch {
    return { path: fallbackPath, additions: 0, deletions: 0, lines: [] };
  }
}

function safeChangedFilePath(value: string): string | null {
  const normalized = value.trim().replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:\//u.test(normalized)) {
    return null;
  }
  const parts = normalized.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return null;
  return parts.join("/").slice(0, 1_024);
}
