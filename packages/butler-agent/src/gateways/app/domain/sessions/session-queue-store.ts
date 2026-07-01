import { Database } from "bun:sqlite";
import type { QueuedMessageRow } from "../../infrastructure/core/records.ts";
import type { AppMessageFileStore } from "../message-files/message-file-store.ts";
import { AppStoreOperationError } from "../../infrastructure/core/app-store-errors.ts";
import { normalizeSessionControls } from "../settings/settings-models.ts";
import { messageFileRefFromRow } from "./message-read-model.ts";
import type { ProviderModelMetadata } from "../../../../integrations/providers/model-catalog.ts";
import type {
  QueueMessageRequest,
  QueuedMessageRecord,
  SessionControlState,
  SessionQueueView,
  UpdateQueuedMessageRequest,
} from "../../interface/protocol/app-protocol.ts";

const DEFAULT_CHAT_ID = "general";

export class AppSessionQueueStore {
  constructor(
    private readonly db: Database,
    private readonly messageFiles: AppMessageFileStore,
    private readonly ensureChat: (sessionId: string) => void,
    private readonly controlsForMessageSend: (
      sessionId: string,
      input: Partial<SessionControlState>,
    ) => SessionControlState,
    private readonly getSessionControls: (
      sessionId: string,
    ) => SessionControlState,
    private readonly registeredModelMetadata: () => ProviderModelMetadata[],
    private readonly appendEvent: (
      type: string,
      payload: Record<string, unknown>,
    ) => void,
  ) {}

  listSessionQueue(sessionId = DEFAULT_CHAT_ID): SessionQueueView {
    this.ensureChat(sessionId);
    const rows = this.db
      .query<QueuedMessageRow, [string]>(
        `
      SELECT rowid, id, chat_id, text, controls_json, attachments_json, state,
        safe_error_code, dispatched_message_id, turn_id, created_at, updated_at
      FROM session_queued_messages
      WHERE chat_id = ? AND state = 'queued'
      ORDER BY rowid ASC
    `,
      )
      .all(sessionId);
    return {
      session_id: sessionId,
      queued_messages: rows.map((row) => this.queuedMessageFromRow(row)),
    };
  }

  createQueuedMessage(input: QueueMessageRequest): SessionQueueView {
    const chatId = input.chat_id?.trim() || DEFAULT_CHAT_ID;
    this.ensureChat(chatId);
    const text = (input.text ?? "").trim();
    const attachableFiles = this.messageFiles.validateAttachable(
      chatId,
      input.attachments ?? [],
    );
    if (!text && attachableFiles.length === 0) {
      throw new AppStoreOperationError(
        400,
        "empty_queued_message",
        "Queued message text is required.",
      );
    }
    const controls = this.controlsForMessageSend(chatId, input);
    const now = new Date().toISOString();
    const queuedId = `queued-${crypto.randomUUID()}`;
    this.db
      .query(
        `
      INSERT INTO session_queued_messages (
        id, chat_id, text, controls_json, attachments_json, state,
        safe_error_code, dispatched_message_id, turn_id, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, 'queued', NULL, NULL, NULL, ?, ?)
    `,
      )
      .run(
        queuedId,
        chatId,
        text,
        JSON.stringify(controls),
        JSON.stringify(attachableFiles.map((file) => file.id)),
        now,
        now,
      );
    this.appendEvent("session_queue.changed", {
      session_id: chatId,
      queued_message_id: queuedId,
      action: "created",
    });
    return this.listSessionQueue(chatId);
  }

  updateQueuedMessage(
    queuedMessageId: string,
    input: UpdateQueuedMessageRequest,
  ): SessionQueueView {
    const current = this.getQueuedMessageRow(queuedMessageId);
    if (!current || current.state !== "queued") {
      throw new AppStoreOperationError(
        404,
        "queued_message_not_found",
        "Queued message not found.",
      );
    }
    const text =
      typeof input.text === "string" ? input.text.trim() : current.text;
    const attachableFiles =
      input.attachments === undefined
        ? this.messageFiles.queuedRows(current)
        : this.messageFiles.validateAttachable(
            current.chat_id,
            input.attachments,
          );
    if (!text && attachableFiles.length === 0) {
      throw new AppStoreOperationError(
        400,
        "empty_queued_message",
        "Queued message text is required.",
      );
    }
    const controls = normalizeSessionControls(
      {
        ...this.queuedControlsFromRow(current),
        model: input.model,
        reasoning_effort: input.reasoning_effort,
        access_mode: input.access_mode,
        plan_mode: input.plan_mode,
      },
      this.registeredModelMetadata(),
    );
    const now = new Date().toISOString();
    this.db
      .query(
        `
      UPDATE session_queued_messages
      SET text = ?, controls_json = ?, attachments_json = ?, updated_at = ?
      WHERE id = ? AND state = 'queued'
    `,
      )
      .run(
        text,
        JSON.stringify(controls),
        JSON.stringify(attachableFiles.map((file) => file.id)),
        now,
        queuedMessageId,
      );
    this.appendEvent("session_queue.changed", {
      session_id: current.chat_id,
      queued_message_id: queuedMessageId,
      action: "updated",
    });
    return this.listSessionQueue(current.chat_id);
  }

  deleteQueuedMessage(queuedMessageId: string): SessionQueueView {
    const current = this.getQueuedMessageRow(queuedMessageId);
    if (!current || current.state !== "queued") {
      throw new AppStoreOperationError(
        404,
        "queued_message_not_found",
        "Queued message not found.",
      );
    }
    const now = new Date().toISOString();
    this.db
      .query(
        `
      UPDATE session_queued_messages
      SET state = 'deleted', updated_at = ?
      WHERE id = ? AND state = 'queued'
    `,
      )
      .run(now, queuedMessageId);
    this.appendEvent("session_queue.changed", {
      session_id: current.chat_id,
      queued_message_id: queuedMessageId,
      action: "deleted",
    });
    return this.listSessionQueue(current.chat_id);
  }

  getQueuedMessageRow(queuedMessageId: string): QueuedMessageRow | null {
    return (
      this.db
        .query<QueuedMessageRow, [string]>(
          `
      SELECT rowid, id, chat_id, text, controls_json, attachments_json, state,
        safe_error_code, dispatched_message_id, turn_id, created_at, updated_at
      FROM session_queued_messages
      WHERE id = ?
    `,
        )
        .get(queuedMessageId) ?? null
    );
  }

  queuedControlsFromRow(row: QueuedMessageRow): SessionControlState {
    try {
      return normalizeSessionControls(
        JSON.parse(row.controls_json) as Partial<SessionControlState>,
        this.registeredModelMetadata(),
      );
    } catch {
      return this.getSessionControls(row.chat_id);
    }
  }

  queuedMessageFromRow(row: QueuedMessageRow): QueuedMessageRecord {
    const attachments = this.messageFiles.queuedRows(row).map(
      messageFileRefFromRow,
    );
    const record: QueuedMessageRecord = {
      id: row.id,
      chat_id: row.chat_id,
      text: row.text,
      controls: this.queuedControlsFromRow(row),
      state: row.state,
      cursor: row.rowid,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
    if (attachments.length > 0) record.attachments = attachments;
    if (row.safe_error_code) record.safe_error_code = row.safe_error_code;
    if (row.dispatched_message_id) {
      record.dispatched_message_id = row.dispatched_message_id;
    }
    if (row.turn_id) record.turn_id = row.turn_id;
    return record;
  }
}
