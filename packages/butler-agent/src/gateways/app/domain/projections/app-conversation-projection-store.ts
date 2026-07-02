import type { Database } from "bun:sqlite";
import type {
  ConversationProjectionEvent,
  ConversationProjectionReader,
} from "../../../../agent/conversation/types.ts";
import { AppConversationMessageProjector } from "./app-conversation-message-projector.ts";
import { AppConversationProjectionReadModel } from "./app-conversation-projection-read-model.ts";
import type {
  AppConversationProjectionActivityState,
  AppConversationProjectionBindingRef,
  AppConversationProjectionRebuildResult,
  AppConversationProjectionReplayResult,
  AppConversationProjectionStatus,
} from "./app-conversation-projection-types.ts";
import type {
  MessageFileRef,
  MessageRecord,
} from "../../interface/protocol/app-protocol.ts";
import {
  deleteStaleSemanticProjectionRows,
  readProjectionAttachmentLinks,
  restoreProjectionAttachmentLinks,
} from "./app-conversation-projection-maintenance.ts";

export type {
  AppConversationProjectionActivityState,
  AppConversationProjectionBindingRef,
  AppConversationProjectionRebuildResult,
  AppConversationProjectionReplayResult,
  AppConversationProjectionStatus,
} from "./app-conversation-projection-types.ts";

const APP_CONVERSATION_GATEWAY = "app";
const DEFAULT_REPLAY_LIMIT = 100;
const MAX_REPLAY_LIMIT = 500;
const REBUILD_PAGE_LIMIT = 500;

export class AppConversationProjectionStore {
  private readonly readModel: AppConversationProjectionReadModel;

  constructor(
    private readonly input: {
      db: Database;
      conversationReader?: ConversationProjectionReader;
      gateway?: string;
    },
  ) {
    this.readModel = new AppConversationProjectionReadModel({
      db: input.db,
      conversationReader: input.conversationReader,
      gateway: () => this.gateway(),
      status: () => this.readState(),
    });
  }

  status(): AppConversationProjectionStatus {
    return this.readState();
  }

  replayOutbox(input: { limit?: number } = {}): AppConversationProjectionReplayResult {
    const reader = this.input.conversationReader;
    if (!reader) {
      const state = this.writeState({
        lastOutboxId: this.readState().last_outbox_id,
        pendingCount: 0,
        safeErrorCode: "conversation_reader_unavailable",
      });
      return {
        ok: false,
        processed: 0,
        projected_messages: 0,
        last_outbox_id: state.last_outbox_id,
        pending_count: state.pending_count,
        safe_error_code: "conversation_reader_unavailable",
      };
    }

    let state = this.readState();
    const limit = normalizedLimit(input.limit);
    const events = reader.readProjectionBatch(state.last_outbox_id, limit);
    let processed = 0;
    let projectedMessages = 0;
    for (const event of events) {
      try {
        projectedMessages += this.projectOutboxEvent(event);
        processed += 1;
        state = this.writeState({
          lastOutboxId: event.outbox_id,
          pendingCount: events.length === limit ? 1 : 0,
          safeErrorCode: null,
        });
      } catch {
        state = this.writeState({
          lastOutboxId: state.last_outbox_id,
          pendingCount: 1,
          safeErrorCode: "conversation_projection_failed",
        });
        return {
          ok: false,
          processed,
          projected_messages: projectedMessages,
          last_outbox_id: state.last_outbox_id,
          pending_count: state.pending_count,
          safe_error_code: "conversation_projection_failed",
          failed_outbox_id: event.outbox_id,
        };
      }
    }
    if (events.length === 0) {
      state = this.writeState({
        lastOutboxId: state.last_outbox_id,
        pendingCount: 0,
        safeErrorCode: null,
      });
    }
    return {
      ok: true,
      processed,
      projected_messages: projectedMessages,
      last_outbox_id: state.last_outbox_id,
      pending_count: state.pending_count,
    };
  }

  projectOutboxEvent(event: ConversationProjectionEvent): number {
    if (event.kind !== "conversation.message_committed") return 0;
    const reader = this.requireReader();
    const message = reader.readMessageById(event.payload_ref);
    if (!message) throw new Error(`Conversation message not found: ${event.payload_ref}`);
    return this.messageProjector(reader).project(message);
  }

  rebuildSession(conversationSessionId: string): AppConversationProjectionRebuildResult {
    const reader = this.requireReader();
    const session = reader.getSession(conversationSessionId);
    if (!session) {
      return {
        ok: false,
        conversation_session_id: conversationSessionId,
        projected_messages: 0,
        safe_error_code: "conversation_session_not_found",
      };
    }
    const binding = reader.getGatewayBindingForConversation(
      conversationSessionId,
      this.gateway(),
    );
    if (!binding) {
      return {
        ok: false,
        conversation_session_id: conversationSessionId,
        projected_messages: 0,
        safe_error_code: "app_conversation_binding_missing",
      };
    }

    const projector = this.messageProjector(reader);
    const attachmentLinks = readProjectionAttachmentLinks(
      this.input.db,
      conversationSessionId,
    );
    projector.ensureProjectionChat(binding.external_session_id, session);
    let projectedMessages = 0;
    let afterSeq = 0;
    const projectedConversationMessageIds = new Set<string>();
    while (true) {
      const messages = reader.readProjectionMessages(conversationSessionId, {
        afterSeq,
        limit: REBUILD_PAGE_LIMIT,
      });
      if (messages.length === 0) break;
      for (const message of messages) {
        const projected = projector.project(message);
        projectedMessages += projected;
        if (projected > 0) projectedConversationMessageIds.add(message.id);
        afterSeq = Math.max(afterSeq, message.seq);
      }
      if (messages.length < REBUILD_PAGE_LIMIT) break;
    }
    deleteStaleSemanticProjectionRows(
      this.input.db,
      conversationSessionId,
      projectedConversationMessageIds,
    );
    restoreProjectionAttachmentLinks(this.input.db, attachmentLinks);
    return {
      ok: true,
      conversation_session_id: conversationSessionId,
      projected_messages: projectedMessages,
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

  private messageProjector(
    reader: ConversationProjectionReader,
  ): AppConversationMessageProjector {
    return new AppConversationMessageProjector({
      db: this.input.db,
      reader,
      gateway: this.gateway(),
    });
  }

  private readState(): AppConversationProjectionStatus {
    const gateway = this.gateway();
    const row = this.input.db.query<AppConversationProjectionStatus, [string]>(`
      SELECT gateway, last_outbox_id, updated_at, pending_count, safe_error_code
      FROM app_conversation_projection_state
      WHERE gateway = ?
    `).get(gateway);
    return row ?? {
      gateway,
      last_outbox_id: null,
      updated_at: null,
      pending_count: 0,
      safe_error_code: null,
    };
  }

  private writeState(input: {
    lastOutboxId: string | null;
    pendingCount: number;
    safeErrorCode: string | null;
  }): AppConversationProjectionStatus {
    const gateway = this.gateway();
    const now = new Date().toISOString();
    this.input.db.query(`
      INSERT INTO app_conversation_projection_state (
        gateway, last_outbox_id, updated_at, pending_count, safe_error_code
      )
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(gateway) DO UPDATE SET
        last_outbox_id = excluded.last_outbox_id,
        updated_at = excluded.updated_at,
        pending_count = excluded.pending_count,
        safe_error_code = excluded.safe_error_code
    `).run(
      gateway,
      input.lastOutboxId,
      now,
      input.pendingCount,
      input.safeErrorCode,
    );
    return {
      gateway,
      last_outbox_id: input.lastOutboxId,
      updated_at: now,
      pending_count: input.pendingCount,
      safe_error_code: input.safeErrorCode,
    };
  }

  private requireReader(): ConversationProjectionReader {
    const reader = this.input.conversationReader;
    if (!reader) throw new Error("Conversation projection reader is not configured.");
    return reader;
  }

  private gateway(): string {
    return this.input.gateway ?? APP_CONVERSATION_GATEWAY;
  }
}

function normalizedLimit(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_REPLAY_LIMIT;
  return Math.max(1, Math.min(MAX_REPLAY_LIMIT, Math.floor(value!)));
}
