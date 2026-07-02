import type { Database } from "bun:sqlite";
import type {
  ConversationMessageWithParts,
  ConversationProjectionReader,
  ConversationRole,
  ConversationSession,
} from "../../../../agent/conversation/types.ts";
import type {
  MessageRole,
  MessageStatus,
} from "../../interface/protocol/app-protocol.ts";
import { appChatIdForConversationExternalSession } from "./app-conversation-session-id.ts";

export class AppConversationMessageProjector {
  private readonly appChatIdByExternalSessionId = new Map<string, string>();

  constructor(
    private readonly input: {
      db: Database;
      reader: Pick<
        ConversationProjectionReader,
        "getGatewayBindingForConversation" | "getSession"
      >;
      gateway: string;
    },
  ) {}

  project(message: ConversationMessageWithParts): number {
    if (message.visibility !== "model" && message.visibility !== "user") return 0;
    const text = textFromConversationMessage(message);
    if (!text) return 0;
    const binding = this.input.reader.getGatewayBindingForConversation(
      message.session_id,
      this.input.gateway,
    );
    if (!binding) {
      throw new Error(`App conversation binding missing: ${message.session_id}`);
    }
    const session = this.input.reader.getSession(message.session_id);
    if (!session) {
      throw new Error(`Conversation session missing: ${message.session_id}`);
    }
    const chatId = this.appChatIdForExternalSession(binding.external_session_id);
    this.ensureProjectionChat(chatId, session);
    const messageId = this.existingProjectionMessageId(
      chatId,
      message,
      text,
    ) ?? `app-projection-${message.id}`;
    const now = new Date().toISOString();
    this.input.db.query(`
      INSERT INTO messages (
        id, chat_id, turn_id, conversation_session_id, conversation_turn_id,
        conversation_message_id, role, text, status, created_at, updated_at,
        safe_error_code, retryable
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0)
      ON CONFLICT(id) DO UPDATE SET
        chat_id = excluded.chat_id,
        turn_id = excluded.turn_id,
        conversation_session_id = excluded.conversation_session_id,
        conversation_turn_id = excluded.conversation_turn_id,
        conversation_message_id = excluded.conversation_message_id,
        role = excluded.role,
        text = excluded.text,
        status = excluded.status,
        updated_at = excluded.updated_at,
        safe_error_code = NULL,
        retryable = 0
    `).run(
      messageId,
      chatId,
      message.turn_id,
      message.session_id,
      message.turn_id,
      message.id,
      appRoleForConversationRole(message.role),
      text,
      appStatusForConversationMessage(message),
      message.created_at,
      now,
    );
    this.input.db.query("UPDATE chats SET updated_at = ? WHERE id = ?")
      .run(now, chatId);
    this.pruneShadowHintChat(binding.external_session_id, chatId, session.id);
    return 1;
  }

  ensureProjectionChat(chatId: string, session: ConversationSession | null): void {
    const now = new Date().toISOString();
    this.input.db.query(`
      INSERT OR IGNORE INTO chats (
        id, title, kind, project_id, conversation_session_id, pinned, archived, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?)
    `).run(
      chatId,
      "Projected conversation",
      session?.project_id ? "project" : "chat",
      session?.project_id ?? null,
      session?.id ?? null,
      now,
      now,
    );
    if (session) {
      this.input.db.query(`
        UPDATE chats
        SET conversation_session_id = ?
        WHERE id = ?
          AND conversation_session_id IS NULL
      `).run(session.id, chatId);
    }
  }

  appChatIdForExternalSession(externalSessionId: string): string {
    const cached = this.appChatIdByExternalSessionId.get(externalSessionId);
    if (cached) return cached;
    const chatId = appChatIdForConversationExternalSession(
      this.input.db,
      externalSessionId,
    );
    this.appChatIdByExternalSessionId.set(externalSessionId, chatId);
    return chatId;
  }

  private pruneShadowHintChat(
    externalSessionId: string,
    chatId: string,
    conversationSessionId: string,
  ): void {
    if (externalSessionId === chatId) return;
    this.input.db.query(`
      UPDATE chats
      SET conversation_session_id = NULL
      WHERE id = ?
        AND conversation_session_id = ?
    `).run(externalSessionId, conversationSessionId);
    this.input.db.query(`
      DELETE FROM chats
      WHERE id = ?
        AND title = 'Projected conversation'
        AND conversation_session_id IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM messages
          WHERE messages.chat_id = chats.id
        )
        AND NOT EXISTS (
          SELECT 1
          FROM turns
          WHERE turns.chat_id = chats.id
        )
    `).run(externalSessionId);
  }

  private existingProjectionMessageId(
    chatId: string,
    message: ConversationMessageWithParts,
    text: string,
  ): string | null {
    const matchingAppRow = this.existingUnboundAppMessageId(chatId, message, text);
    const byConversationId = this.input.db.query<{ id: string }, [string]>(`
      SELECT id
      FROM messages
      WHERE conversation_message_id = ?
      LIMIT 1
    `).get(message.id);
    if (matchingAppRow) {
      if (byConversationId && byConversationId.id !== matchingAppRow) {
        this.removeDuplicateProjectionMessage(byConversationId.id, matchingAppRow);
      }
      return matchingAppRow;
    }
    if (byConversationId) return byConversationId.id;
    return null;
  }

  private existingUnboundAppMessageId(
    chatId: string,
    message: ConversationMessageWithParts,
    text: string,
  ): string | null {
    if (!message.turn_id) return null;
    return this.input.db.query<{ id: string }, [string, string, string, string]>(`
      SELECT id
      FROM messages
      WHERE chat_id = ?
        AND turn_id = ?
        AND conversation_message_id IS NULL
        AND role = ?
        AND text = ?
      ORDER BY rowid ASC
      LIMIT 1
    `).get(
      chatId,
      message.turn_id,
      appRoleForConversationRole(message.role),
      text,
    )?.id ?? null;
  }

  private removeDuplicateProjectionMessage(
    duplicateMessageId: string,
    targetMessageId: string,
  ): void {
    this.input.db.query(`
      INSERT OR IGNORE INTO message_attachments (message_id, file_id, position)
      SELECT ?, file_id, position
      FROM message_attachments
      WHERE message_id = ?
    `).run(targetMessageId, duplicateMessageId);
    this.input.db.query(`
      UPDATE message_files
      SET message_id = ?
      WHERE message_id = ?
    `).run(targetMessageId, duplicateMessageId);
    this.input.db.query("DELETE FROM messages WHERE id = ?")
      .run(duplicateMessageId);
  }
}

function textFromConversationMessage(message: ConversationMessageWithParts): string {
  return message.parts
    .flatMap((part) => {
      if (part.kind !== "text") return [];
      const content = part.content_json;
      if (!content || typeof content !== "object" || Array.isArray(content)) return [];
      const text = (content as Record<string, unknown>).text;
      return typeof text === "string" && text.trim() ? [text.trim()] : [];
    })
    .join("\n")
    .trim();
}

function appRoleForConversationRole(role: ConversationRole): MessageRole {
  if (role === "user" || role === "assistant" || role === "system") return role;
  return role === "tool" ? "tool_summary" : "system";
}

function appStatusForConversationMessage(message: ConversationMessageWithParts): MessageStatus {
  if (message.status === "failed") return "failed";
  if (message.role === "user") return "sent";
  return "delivered";
}
