import type { Database } from "bun:sqlite";
import { AppConversationProjectionReadModel } from
  "./app-conversation-projection-read-model.ts";
import type {
  AppConversationProjectionActivityState,
  AppConversationProjectionBindingRef,
  AppConversationProjectionRebuildResult,
  AppConversationProjectionReplayResult,
  AppConversationProjectionStatus,
} from "./app-conversation-projection-types.ts";
import type { MessageFileRef, MessageRecord } from
  "../../interface/protocol/app-protocol.ts";

export type {
  AppConversationProjectionActivityState,
  AppConversationProjectionBindingRef,
  AppConversationProjectionRebuildResult,
  AppConversationProjectionReplayResult,
  AppConversationProjectionStatus,
} from "./app-conversation-projection-types.ts";

const APP_CONVERSATION_GATEWAY = "app";

/** App-owned compatibility view. Live projection is driven only by DeliveryGuard transcripts. */
export class AppConversationProjectionStore {
  private readonly readModel: AppConversationProjectionReadModel;

  constructor(private readonly input: { db: Database; gateway?: string }) {
    this.readModel = new AppConversationProjectionReadModel({
      db: input.db,
      gateway: () => this.gateway(),
      status: () => this.readState(),
    });
  }

  status(): AppConversationProjectionStatus {
    return this.readState();
  }

  replayOutbox(): AppConversationProjectionReplayResult {
    const state = this.readState();
    return {
      ok: true,
      processed: 0,
      projected_messages: 0,
      last_outbox_id: state.last_outbox_id,
      pending_count: 0,
    };
  }

  rebuildSession(conversationSessionId: string): AppConversationProjectionRebuildResult {
    const binding = this.readConversationBinding(conversationSessionId);
    if (!binding) {
      return {
        ok: false,
        conversation_session_id: conversationSessionId,
        projected_messages: 0,
        safe_error_code: "conversation_session_not_found",
      };
    }
    const count = this.input.db.query<{ count: number }, [string]>(`
      SELECT COUNT(*) AS count FROM messages
      WHERE conversation_session_id = ? AND conversation_message_id IS NOT NULL
    `).get(conversationSessionId)?.count ?? 0;
    return {
      ok: true,
      conversation_session_id: conversationSessionId,
      projected_messages: count,
    };
  }

  appSessionIdForConversation(conversationSessionId: string): string | null {
    return this.readModel.appSessionIdForConversation(conversationSessionId);
  }

  readConversationBinding(
    conversationSessionId: string,
  ): AppConversationProjectionBindingRef | null {
    return this.readModel.readConversationBinding(conversationSessionId);
  }

  listMessageProjection(
    conversationSessionId: string,
    cursor = 0,
    refsForMessage: (messageId: string) => MessageFileRef[] = () => [],
  ): MessageRecord[] {
    return this.readModel.listMessageProjection(
      conversationSessionId,
      cursor,
      refsForMessage,
    );
  }

  readActivityState(conversationSessionId: string): AppConversationProjectionActivityState {
    return this.readModel.readActivityState(conversationSessionId);
  }

  private readState(): AppConversationProjectionStatus {
    const gateway = this.gateway();
    return this.input.db.query<AppConversationProjectionStatus, [string]>(`
      SELECT gateway, last_outbox_id, updated_at, pending_count, safe_error_code
      FROM app_conversation_projection_state WHERE gateway = ?
    `).get(gateway) ?? {
      gateway,
      last_outbox_id: null,
      updated_at: null,
      pending_count: 0,
      safe_error_code: null,
    };
  }

  private gateway(): string {
    return this.input.gateway ?? APP_CONVERSATION_GATEWAY;
  }
}
