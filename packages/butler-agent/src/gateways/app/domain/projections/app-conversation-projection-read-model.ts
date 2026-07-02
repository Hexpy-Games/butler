import type { Database } from "bun:sqlite";
import type { ConversationProjectionReader } from "../../../../agent/conversation/types.ts";
import type { MessageRow } from "../../infrastructure/core/records.ts";
import type {
  MessageFileRef,
  MessageRecord,
  TurnState,
} from "../../interface/protocol/app-protocol.ts";
import { messageFromRow } from "../sessions/message-read-model.ts";
import { visibleMessageSqlPredicate } from "../sessions/visible-message-sql.ts";
import type {
  AppConversationProjectionActivityState,
  AppConversationProjectionBindingRef,
  AppConversationProjectionStatus,
} from "./app-conversation-projection-types.ts";

export class AppConversationProjectionReadModel {
  constructor(
    private readonly input: {
      db: Database;
      conversationReader?: ConversationProjectionReader;
      gateway: () => string;
      status: () => AppConversationProjectionStatus;
    },
  ) {}

  appSessionIdForConversation(conversationSessionId: string): string | null {
    return this.readConversationBinding(conversationSessionId)?.external_session_id ?? null;
  }

  readConversationBinding(
    conversationSessionId: string,
  ): AppConversationProjectionBindingRef | null {
    const fromChat = this.input.db.query<{
      id: string;
      conversation_session_id: string;
    }, [string]>(`
      SELECT id, conversation_session_id
      FROM chats
      WHERE conversation_session_id = ?
      LIMIT 1
    `).get(conversationSessionId);
    if (fromChat) {
      return {
        gateway: this.input.gateway(),
        external_session_id: fromChat.id,
        conversation_session_id: fromChat.conversation_session_id,
      };
    }
    const binding = this.input.conversationReader
      ?.getGatewayBindingForConversation(conversationSessionId, this.input.gateway());
    if (!binding) return null;
    return {
      gateway: binding.gateway,
      external_session_id: binding.external_session_id,
      conversation_session_id: binding.conversation_session_id,
    };
  }

  listMessageProjection(
    conversationSessionId: string,
    cursor = 0,
    refsForMessage: (messageId: string) => MessageFileRef[] = () => [],
  ): MessageRecord[] {
    const rows = this.input.db.query<MessageRow, [string, number]>(`
      SELECT rowid, id, chat_id, turn_id, conversation_session_id, conversation_turn_id,
        conversation_message_id, role, text, status, created_at, updated_at, safe_error_code, retryable
      FROM messages
      WHERE conversation_session_id = ?
        AND rowid > ?
        AND conversation_message_id IS NOT NULL
        AND ${visibleMessageSqlPredicate()}
      ORDER BY rowid ASC
      LIMIT 200
    `).all(conversationSessionId, cursor);
    return rows.map((row) => messageFromRow(row, refsForMessage(row.id)));
  }

  readActivityState(conversationSessionId: string): AppConversationProjectionActivityState {
    const appSessionId = this.appSessionIdForConversation(conversationSessionId);
    const latestTurn = appSessionId
      ? this.input.db.query<{
        state: TurnState;
        safe_error_code: string | null;
        updated_at: string;
      }, [string]>(`
        SELECT state, safe_error_code, updated_at
        FROM turns
        WHERE chat_id = ?
        ORDER BY rowid DESC
        LIMIT 1
      `).get(appSessionId)
      : null;
    const state = this.input.status();
    return {
      conversation_session_id: conversationSessionId,
      app_session_id: appSessionId,
      latest_turn_state: latestTurn?.state ?? null,
      latest_turn_safe_error_code: latestTurn?.safe_error_code ?? null,
      latest_activity_updated_at: latestTurn?.updated_at ?? state.updated_at,
      projection_pending_count: state.pending_count,
      safe_error_code: state.safe_error_code,
    };
  }
}
