import { Database } from "bun:sqlite";
import type { AppMessageFileStore } from "../message-files/message-file-store.ts";
import { AppStoreOperationError } from "../../infrastructure/core/app-store-errors.ts";
import type { QueuedMessageRow } from "../../infrastructure/core/records.ts";
import type {
  MessageSendRequest,
  MessageSendResult,
  SessionControlState,
} from "../../interface/protocol/app-protocol.ts";
import type {
  AppMessageResponder,
  SendMessageOptions,
} from "./message-responder-contract.ts";
import type { VisualImageAdmissionResult } from "../../../../agent/image-attachment/contracts.ts";

export class AppSessionQueueDispatcher {
  constructor(
    private readonly input: {
      db: Database;
      messageFiles: AppMessageFileStore;
      sessionHasActiveTurn: (sessionId: string) => boolean;
      queuedControlsFromRow: (row: QueuedMessageRow) => SessionControlState;
      sendMessage: (
        input: MessageSendRequest,
        responder?: AppMessageResponder,
        options?: SendMessageOptions,
        visualAdmission?: VisualImageAdmissionResult,
      ) => Promise<MessageSendResult>;
      validateVisualAdmission: (
        admission: VisualImageAdmissionResult,
        model: string,
      ) => Promise<VisualImageAdmissionResult>;
      appendEvent: (type: string, payload: Record<string, unknown>) => void;
    },
  ) {}

  async drain(
    chatId: string,
    responder?: AppMessageResponder,
    options: SendMessageOptions = {},
  ): Promise<void> {
    const rows = this.input.db
      .query<QueuedMessageRow, [string]>(
        `
      SELECT rowid, id, chat_id, text, controls_json, attachments_json, state,
        safe_error_code, dispatched_message_id, turn_id, created_at, updated_at
      FROM session_queued_messages
      WHERE chat_id = ? AND state = 'queued'
      ORDER BY rowid ASC
      LIMIT 20
    `,
      )
      .all(chatId);
    for (const row of rows) {
      if (this.input.sessionHasActiveTurn(chatId)) return;
      this.markDispatching(chatId, row.id);
      try {
        const controls = this.input.queuedControlsFromRow(row);
        const visualAdmission = parseQueuedVisualAdmission(row.attachments_json);
        const validatedVisual = visualAdmission
          ? await this.input.validateVisualAdmission(visualAdmission, controls.model)
          : undefined;
        const result = await this.input.sendMessage(
          queuedMessageSendRequest(
            chatId,
            row,
            controls,
            this.input.messageFiles,
          ),
          responder,
          options,
          validatedVisual,
        );
        this.markDispatched(chatId, row.id, result);
      } catch (error) {
        this.markFailed(chatId, row.id, safeQueueDispatchErrorCode(error));
      }
    }
  }

  private markDispatching(chatId: string, queuedMessageId: string): void {
    const now = new Date().toISOString();
    this.input.db
      .query(
        `
        UPDATE session_queued_messages
        SET state = 'dispatching', updated_at = ?
        WHERE id = ? AND state = 'queued'
      `,
      )
      .run(now, queuedMessageId);
    this.input.appendEvent("session_queue.changed", {
      session_id: chatId,
      queued_message_id: queuedMessageId,
      action: "dispatching",
    });
  }

  private markDispatched(
    chatId: string,
    queuedMessageId: string,
    result: MessageSendResult,
  ): void {
    const dispatchedAt = new Date().toISOString();
    this.input.db
      .query(
        `
          UPDATE session_queued_messages
          SET state = 'dispatched', dispatched_message_id = ?, turn_id = ?,
            safe_error_code = NULL, updated_at = ?
          WHERE id = ?
        `,
      )
      .run(
        result.accepted?.id ?? null,
        result.turn?.id ?? null,
        dispatchedAt,
        queuedMessageId,
      );
    this.input.appendEvent("session_queue.changed", {
      session_id: chatId,
      queued_message_id: queuedMessageId,
      action: "dispatched",
      message_id: result.accepted?.id,
      turn_id: result.turn?.id,
    });
  }

  private markFailed(
    chatId: string,
    queuedMessageId: string,
    safeErrorCode: string,
  ): void {
    this.input.db
      .query(
        `
          UPDATE session_queued_messages
          SET state = 'failed', safe_error_code = ?, updated_at = ?
          WHERE id = ?
        `,
      )
      .run(safeErrorCode, new Date().toISOString(), queuedMessageId);
    this.input.appendEvent("session_queue.changed", {
      session_id: chatId,
      queued_message_id: queuedMessageId,
      action: "failed",
      safe_error_code: safeErrorCode,
    });
  }
}

function queuedMessageSendRequest(
  chatId: string,
  row: QueuedMessageRow,
  controls: SessionControlState,
  messageFiles: AppMessageFileStore,
): MessageSendRequest {
  return {
    chat_id: chatId,
    text: row.text,
    client_message_id: `queued-message-${row.id}`,
    model: controls.model,
    reasoning_effort: controls.reasoning_effort,
    access_mode: controls.access_mode,
    plan_mode: controls.plan_mode,
    attachments: messageFiles.queuedRows(row).map((file) => ({
      file_id: file.id,
    })),
  };
}

function parseQueuedVisualAdmission(value: string): VisualImageAdmissionResult | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return undefined;
    const imageEntries = parsed.filter((item) => item && typeof item === "object" &&
      "file_id" in item) as Array<{ file_id?: unknown; image_admission?: unknown }>;
    if (imageEntries.length === 0) return undefined;
    const admissions = imageEntries.map((entry) => {
      const admission = entry.image_admission;
      if (!admission || typeof admission !== "object" ||
          !("tuple" in admission) || !("capability" in admission) || !("manifests" in admission)) {
        throw new AppStoreOperationError(409, "image_carrier_unverified", "Queued image admission is incomplete.");
      }
      return admission as VisualImageAdmissionResult;
    });
    const first = admissions[0]!;
    for (const admission of admissions.slice(1)) {
      if (JSON.stringify(admission.tuple) !== JSON.stringify(first.tuple) ||
          JSON.stringify(admission.capability) !== JSON.stringify(first.capability)) {
        throw new AppStoreOperationError(409, "image_carrier_unverified", "Queued image admissions disagree.");
      }
    }
    return {
      tuple: first.tuple,
      capability: first.capability,
      manifests: admissions.flatMap((admission) => admission.manifests),
    };
  } catch (error) {
    if (error instanceof AppStoreOperationError) throw error;
    throw new AppStoreOperationError(409, "image_carrier_unverified", "Queued image admission is invalid.");
  }
}

function safeQueueDispatchErrorCode(error: unknown): string {
  return error instanceof AppStoreOperationError
    ? error.code
    : "queued_message_dispatch_failed";
}
