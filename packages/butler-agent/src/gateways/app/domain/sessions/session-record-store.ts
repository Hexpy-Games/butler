import { Database } from "bun:sqlite";
import type {
  ChatRow,
  MessageRow,
  ProjectRow,
  SessionSummaryRow,
  TurnRow,
} from "../../infrastructure/core/records.ts";
import type {
  MessageFileRow,
  AppMessageFileStore,
} from "../message-files/message-file-store.ts";
import { AppStoreOperationError } from "../../infrastructure/core/app-store-errors.ts";
import { safeLocalSessionId, sessionFromRow } from "./session-read-model.ts";
import { turnFromRow } from "./message-read-model.ts";
import { publicTurnRecord } from "../../infrastructure/transport/btcc-public-projection.ts";
import type {
  CreateSessionRequest,
  CreateSessionResult,
  MessageRecord,
  MessageRole,
  MessageStatus,
  SessionArtifactSummary,
  SessionActionResult,
  SessionSummary,
  TurnRecord,
  UpdateSessionRequest,
} from "../../interface/protocol/app-protocol.ts";
import { visibleMessageSqlPredicate } from "../sessions/visible-message-sql.ts";
import { AppSessionMessageRecordStore } from "./session-message-record-store.ts";
import type {
  SessionMessagePage,
  SessionMessagePageOptions,
  TranscriptMessagePage,
} from "./session-message-page.ts";

export class AppSessionRecordStore {
  private readonly messages: AppSessionMessageRecordStore;

  constructor(
    private readonly db: Database,
    private readonly butlerData: string,
    private readonly messageFiles: AppMessageFileStore,
    private readonly getProjectRow: (projectId: string) => ProjectRow | null,
    private readonly appendEvent: (
      type: string,
      payload: Record<string, unknown>,
    ) => void,
  ) {
    this.messages = new AppSessionMessageRecordStore(
      db,
      butlerData,
      messageFiles,
      (chatId) => this.ensureChat(chatId),
    );
  }

  ensureChat(chatId: string): void {
    const row = this.db
      .query<{ id: string }, [string]>("SELECT id FROM chats WHERE id = ?")
      .get(chatId);
    if (!row) throw new Error(`Unknown chat: ${chatId}`);
  }

  createSession(input: CreateSessionRequest): CreateSessionResult {
    const kind = input.kind;
    const projectId = kind === "project" ? input.project_id?.trim() : undefined;
    if (kind === "project") {
      if (!projectId) {
        throw new AppStoreOperationError(
          400,
          "project_required",
          "Project session requires a project.",
        );
      }
      if (!this.getProjectRow(projectId)) {
        throw new AppStoreOperationError(
          404,
          "project_not_found",
          "Project not found.",
        );
      }
    }
    const title =
      input.title?.trim() ||
      (kind === "project" ? "New project chat" : "New chat");
    const id = input.session_hint?.trim()
      ? safeLocalSessionId(input.session_hint)
      : `${kind}-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    this.db
      .query(
        `
      INSERT INTO chats (id, title, kind, project_id, pinned, archived, created_at, updated_at)
      VALUES (?, ?, ?, ?, 0, 0, ?, ?)
    `,
      )
      .run(id, title, kind, projectId ?? null, now, now);
    const session = this.getSession(id);
    this.appendEvent("session.created", { session });
    return { session };
  }

  updateSession(
    sessionId: string,
    input: UpdateSessionRequest,
  ): SessionActionResult {
    const current = this.getSession(sessionId);
    const title = input.title?.trim();
    if (input.title !== undefined && !title) {
      throw new AppStoreOperationError(
        400,
        "session_title_required",
        "Session title is required.",
      );
    }
    const nextTitle = title ?? current.title;
    const nextArchived =
      typeof input.archived === "boolean" ? input.archived : current.archived;
    const now = new Date().toISOString();
    this.db
      .query(
        `
      UPDATE chats
      SET title = ?, archived = ?, updated_at = ?
      WHERE id = ?
    `,
      )
      .run(nextTitle, nextArchived ? 1 : 0, now, sessionId);
    const session = this.getSession(sessionId);
    this.appendEvent("session.updated", { session });
    return { session };
  }

  deleteSessionPermanent(sessionId: string): SessionActionResult {
    const session = this.getSession(sessionId);
    this.db.query("DELETE FROM chats WHERE id = ?").run(sessionId);
    this.appendEvent("session.permanently_deleted", { session });
    return { session };
  }

  getSession(sessionId: string): SessionSummary {
    const row = this.db
      .query<SessionSummaryRow, [string]>(
        `
      SELECT
        c.id,
        c.kind,
        c.title,
        c.project_id,
        c.created_at,
        c.updated_at,
        (
          SELECT m.text
          FROM messages m
          WHERE m.chat_id = c.id
            AND ${visibleMessageSqlPredicate("m")}
          ORDER BY m.rowid DESC
          LIMIT 1
        ) AS last_message_preview,
        (
          SELECT t.state
          FROM turns t
          WHERE t.chat_id = c.id
          ORDER BY t.rowid DESC
          LIMIT 1
        ) AS active_turn_state,
        (
          SELECT t.safe_status_label
          FROM turns t
          WHERE t.chat_id = c.id
          ORDER BY t.rowid DESC
          LIMIT 1
        ) AS safe_status_label,
        (
          SELECT t.safe_error_code
          FROM turns t
          WHERE t.chat_id = c.id
          ORDER BY t.rowid DESC
          LIMIT 1
        ) AS active_turn_safe_error_code,
        c.pinned,
        c.archived
      FROM chats c
      WHERE c.id = ?
    `,
      )
      .get(sessionId);
    if (!row) {
      throw new AppStoreOperationError(
        404,
        "session_not_found",
        "Session not found.",
      );
    }
    return sessionFromRow(row);
  }

  listTurns(chatId: string, cursor = 0): TurnRecord[] {
    this.ensureChat(chatId);
    const rows = this.db
      .query<TurnRow, [string, number]>(
        `
      SELECT rowid, id, chat_id, user_message_id, state, safe_status_label, safe_error_code,
        retryable, cancellable, attempt, execution_controls_json, execution_model_json,
        created_at, updated_at
      FROM turns
      WHERE chat_id = ? AND rowid > ?
      ORDER BY rowid ASC
      LIMIT 200
    `,
      )
      .all(chatId, cursor);
    return rows.map((row) => publicTurnRecord(turnFromRow(row)));
  }

  latestTurn(chatId: string): TurnRecord | null {
    this.ensureChat(chatId);
    const row = this.db
      .query<TurnRow, [string]>(
        `
      SELECT rowid, id, chat_id, user_message_id, state, safe_status_label, safe_error_code,
        retryable, cancellable, attempt, execution_controls_json, execution_model_json,
        created_at, updated_at
      FROM turns
      WHERE chat_id = ?
      ORDER BY rowid DESC
      LIMIT 1
    `,
      )
      .get(chatId);
    return row ? publicTurnRecord(turnFromRow(row)) : null;
  }

  countTurns(chatId: string): number {
    this.ensureChat(chatId);
    return (
      this.db
        .query<
          { count: number },
          [string]
        >("SELECT COUNT(*) AS count FROM turns WHERE chat_id = ?")
        .get(chatId)?.count ?? 0
    );
  }

  getChatRow(chatId: string): ChatRow | null {
    return (
      this.db
        .query<ChatRow, [string]>(
          `
      SELECT id, title, kind, project_id, conversation_session_id, created_at, updated_at
      FROM chats
      WHERE id = ?
    `,
        )
        .get(chatId) ?? null
    );
  }

  listMessages(
    chatId: string,
    cursorOrOptions: number | SessionMessagePageOptions = 0,
  ): MessageRecord[] {
    return this.messages.listMessages(chatId, cursorOrOptions);
  }

  listMessagePage(
    chatId: string,
    cursorOrOptions: number | SessionMessagePageOptions = 0,
  ): SessionMessagePage<MessageRecord> {
    return this.messages.listMessagePage(chatId, cursorOrOptions);
  }

  latestMessageRevision(chatId: string): string {
    return this.messages.latestMessageRevision(chatId);
  }

  listArtifactSummaries(chatId: string): SessionArtifactSummary[] {
    return this.messages.listArtifactSummaries(chatId);
  }

  listTranscriptMessagePage(
    chatId: string,
    options?: SessionMessagePageOptions,
  ): TranscriptMessagePage {
    return this.messages.listTranscriptMessagePage(chatId, options);
  }

  getMessageRow(messageId: string): MessageRow | null {
    return this.messages.getMessageRow(messageId);
  }

  messageRecordById(messageId: string): MessageRecord {
    return this.messages.messageRecordById(messageId);
  }

  getLatestAssistantMessageForTurn(turnId: string): MessageRow | null {
    return this.messages.getLatestAssistantMessageForTurn(turnId);
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
    return this.messages.insertMessage(chatId, role, text, status, options);
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
    return this.messages.updateMessage(messageId, input);
  }

  touchChat(chatId: string): void {
    this.messages.touchChat(chatId);
  }
}
