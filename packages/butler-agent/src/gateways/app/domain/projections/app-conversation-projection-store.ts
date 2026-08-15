import type { Database } from "bun:sqlite";
import type {
  ConversationProjectionEvent,
  ConversationProjectionReader,
} from "../../../../agent/conversation/types.ts";
import { conversationMessageText } from "../../../../agent/conversation/message-text.ts";
import { AppConversationMessageProjector } from "./app-conversation-message-projector.ts";
import { AppConversationProjectionReadModel } from "./app-conversation-projection-read-model.ts";
import { appChatIdForConversationExternalSession } from "./app-conversation-session-id.ts";
import type {
  AppConversationProjectionActivityState,
  AppConversationProjectionBindingRef,
  AppConversationProjectionRebuildResult,
  AppConversationProjectionReplayResult,
  AppConversationProjectionStatus,
  AppConversationTurnOutcomeProjector,
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
  AppConversationTurnOutcomeProjection,
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
      projectTurnOutcome: AppConversationTurnOutcomeProjector;
      recordProjectionFailure?: (error: unknown) => void;
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
        lastOutcomeId: this.readState().last_outcome_id,
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

    if (reader.isAvailable && !reader.isAvailable()) {
      const state = this.writeState({
        lastOutboxId: this.readState().last_outbox_id,
        lastOutcomeId: this.readState().last_outcome_id,
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
    const projector = this.messageProjector(reader);
    let processed = 0;
    let projectedMessages = 0;
    for (const event of events) {
      try {
        projectedMessages += this.projectOutboxEvent(event, projector);
        processed += 1;
        state = this.writeState({
          lastOutboxId: event.outbox_id,
          lastOutcomeId: state.last_outcome_id,
          pendingCount: events.length === limit ? 1 : 0,
          safeErrorCode: null,
        });
      } catch (error) {
        this.input.recordProjectionFailure?.(error);
        state = this.writeState({
          lastOutboxId: state.last_outbox_id,
          lastOutcomeId: state.last_outcome_id,
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
    const outcomePage = reader.readTurnOutcomes(state.last_outcome_id, limit);
    let projectedOutcomes = 0;
    for (const outcome of outcomePage) {
      try {
        projectedOutcomes += this.projectTurnOutcome(outcome, outcome.session_id) ? 1 : 0;
        state = this.writeState({
          lastOutboxId: state.last_outbox_id,
          lastOutcomeId: outcome.id,
          pendingCount: outcomePage.length === limit ? 1 : 0,
          safeErrorCode: null,
        });
      } catch (error) {
        this.input.recordProjectionFailure?.(error);
        state = this.writeState({
          lastOutboxId: state.last_outbox_id,
          lastOutcomeId: state.last_outcome_id,
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
          failed_outcome_id: outcome.id,
        };
      }
    }
    if (outcomePage.length === 0 && events.length === 0) {
      state = this.writeState({
        lastOutboxId: state.last_outbox_id,
        lastOutcomeId: state.last_outcome_id,
        pendingCount: 0,
        safeErrorCode: null,
      });
    }
    return {
      ok: true,
      processed,
      projected_messages: projectedMessages + projectedOutcomes,
      last_outbox_id: state.last_outbox_id,
      pending_count: state.pending_count,
    };
  }

  projectOutboxEvent(
    event: ConversationProjectionEvent,
    projector: AppConversationMessageProjector | null = null,
  ): number {
    const reader = this.requireReader();
    if (event.kind === "conversation.turn_outcome_written") {
      const outcome = reader.readTurnOutcomeById(event.payload_ref);
      if (!outcome) {
        throw new Error(`Conversation turn outcome not found: ${event.payload_ref}`);
      }
      if (outcome.session_id !== event.conversation_session_id) {
        throw new Error(`Conversation turn outcome session mismatch: ${event.payload_ref}`);
      }
      this.projectTurnOutcome(outcome, event.conversation_session_id);
      return 0;
    }
    if (event.kind !== "conversation.message_committed") return 0;
    const message = reader.readMessageById(event.payload_ref);
    if (!message) throw new Error(`Conversation message not found: ${event.payload_ref}`);
    return (projector ?? this.messageProjector(reader)).project(message);
  }

  private projectTurnOutcome(
    outcome: import("../../../../agent/conversation/types.ts").TurnOutcomeCapsule,
    expectedSessionId: string,
  ): boolean {
    const reader = this.requireReader();
    if (outcome.session_id !== expectedSessionId) {
      throw new Error(`Conversation turn outcome session mismatch: ${outcome.id}`);
    }
    const binding = reader.getGatewayBindingForConversation(
      outcome.session_id,
      this.gateway(),
    );
    if (!binding) {
      throw new Error(`App conversation binding missing: ${outcome.session_id}`);
    }
    const assistant = outcome.public_assistant_message_id
      ? reader.readMessageById(outcome.public_assistant_message_id)
      : null;
    if (outcome.outcome === "delivered" && !assistant) {
      throw new Error(
        `Conversation assistant message not found: ${outcome.public_assistant_message_id ?? "missing"}`,
      );
    }
    const appChatId = appChatIdForConversationExternalSession(
      this.input.db,
      binding.external_session_id,
    );
    const appTurnId = this.appTurnIdForConversationOutcome({
      appChatId,
      turnId: outcome.turn_id,
      requestMessageId: outcome.request_message_id,
      assistantMessageId: outcome.public_assistant_message_id,
    });
    if (!appTurnId) {
      throw new Error(`App turn not found for conversation outcome: ${outcome.turn_id}`);
    }
    return this.input.projectTurnOutcome({
      outcome_id: outcome.id,
      app_chat_id: appChatId,
      app_turn_id: appTurnId,
      outcome: outcome.outcome,
      safe_code: outcome.safe_code,
      assistant_text: assistant ? conversationMessageText(assistant) : null,
      assistant_message_id: outcome.public_assistant_message_id,
      created_at: outcome.created_at,
    });
  }

  private appTurnIdForConversationOutcome(input: {
    appChatId: string;
    turnId: string;
    requestMessageId: string | null;
    assistantMessageId: string | null;
  }): string | null {
    const direct = this.input.db.query<{ id: string }, [string, string]>(`
      SELECT id
      FROM turns
      WHERE id = ? AND chat_id = ?
      LIMIT 1
    `).get(input.turnId, input.appChatId);
    if (direct) return direct.id;
    const byConversationRef = this.input.db.query<{ id: string }, [string, string, string, string]>(`
      SELECT turns.id
      FROM turns
      JOIN messages ON messages.turn_id = turns.id
      WHERE turns.chat_id = ?
        AND (
          messages.conversation_turn_id = ?
          OR messages.conversation_message_id IN (?, ?)
        )
      ORDER BY turns.rowid DESC
      LIMIT 1
    `).get(
      input.appChatId,
      input.turnId,
      input.requestMessageId ?? "",
      input.assistantMessageId ?? "",
    );
    return byConversationRef?.id ?? null;
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
    projector.ensureProjectionChat(
      projector.appChatIdForExternalSession(binding.external_session_id),
      session,
    );
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
      SELECT gateway, last_outbox_id, last_outcome_id, updated_at, pending_count, safe_error_code
      FROM app_conversation_projection_state
      WHERE gateway = ?
    `).get(gateway);
    return row ?? {
      gateway,
      last_outbox_id: null,
      last_outcome_id: null,
      updated_at: null,
      pending_count: 0,
      safe_error_code: null,
    };
  }

  private writeState(input: {
    lastOutboxId: string | null;
    lastOutcomeId: string | null;
    pendingCount: number;
    safeErrorCode: string | null;
  }): AppConversationProjectionStatus {
    const gateway = this.gateway();
    const now = new Date().toISOString();
    this.input.db.query(`
      INSERT INTO app_conversation_projection_state (
        gateway, last_outbox_id, last_outcome_id, updated_at, pending_count, safe_error_code
      )
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(gateway) DO UPDATE SET
        last_outbox_id = excluded.last_outbox_id,
        last_outcome_id = excluded.last_outcome_id,
        updated_at = excluded.updated_at,
        pending_count = excluded.pending_count,
        safe_error_code = excluded.safe_error_code
    `).run(
      gateway,
      input.lastOutboxId,
      input.lastOutcomeId,
      now,
      input.pendingCount,
      input.safeErrorCode,
    );
    return {
      gateway,
      last_outbox_id: input.lastOutboxId,
      last_outcome_id: input.lastOutcomeId,
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
