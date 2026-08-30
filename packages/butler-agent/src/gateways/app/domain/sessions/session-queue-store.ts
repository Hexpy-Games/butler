import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { QueuedMessageRow } from "../../infrastructure/core/records.ts";
import type { AppMessageFileStore } from "../message-files/message-file-store.ts";
import { AppStoreOperationError } from "../../infrastructure/core/app-store-errors.ts";
import { normalizeSessionControls } from "../settings/settings-models.ts";
import { messageFileRefFromRow } from "./message-read-model.ts";
import type { ProviderModelMetadata } from "../../../../integrations/providers/model-catalog.ts";
import type { TurnControlResolution } from "../../../core/turn-execution-controls.ts";
import type {
  QueueMessageRequest,
  QueuedMessageRecord,
  SessionControlState,
  SessionQueueView,
  UpdateQueuedMessageRequest,
} from "../../interface/protocol/app-protocol.ts";
import type { VisualImageAdmissionResult } from "../../../../agent/image-attachment/contracts.ts";

const DEFAULT_CHAT_ID = "general";
export const SESSION_QUEUE_LEASE_MS = 60_000;
const PROCESS_QUEUE_OWNER_INCARNATION = crypto.randomUUID();
const LIVE_QUEUE_OWNERS = new Set<string>();
const QUEUE_OWNER_UNREGISTER_HANDLERS = new Map<string, () => void>();

export function createQueueOwner(): string {
  return `app-session-queue:${process.pid}:${PROCESS_QUEUE_OWNER_INCARNATION}:${crypto.randomUUID()}`;
}

export function registerQueueOwner(owner: string, onUnregistered?: () => void): void {
  LIVE_QUEUE_OWNERS.add(owner);
  if (onUnregistered) QUEUE_OWNER_UNREGISTER_HANDLERS.set(owner, onUnregistered);
}

export function unregisterQueueOwner(owner: string): void {
  LIVE_QUEUE_OWNERS.delete(owner);
  QUEUE_OWNER_UNREGISTER_HANDLERS.delete(owner);
  for (const wake of QUEUE_OWNER_UNREGISTER_HANDLERS.values()) {
    try {
      wake();
    } catch {
      // A lifecycle wake is best effort; the durable lease deadline remains
      // the recovery authority if a sibling is already closing.
    }
  }
}

export type QueuedTurnClaimStatus =
  | "unlinked"
  | "current"
  | "terminal"
  | "stale";

function queueAttachmentPayload(
  files: readonly import("../message-files/message-file-store.ts").MessageFileRow[],
  admission?: VisualImageAdmissionResult,
): Array<string | {
  file_id: string;
  image_admission: VisualImageAdmissionResult;
}> {
  return files.map((file) => {
    const manifest = admission?.manifests.find((item) => item.fileId === file.id);
    if (!manifest || !admission) return file.id;
    return {
      file_id: file.id,
      image_admission: {
        ...admission,
        manifests: [manifest],
      },
    };
  });
}

export class AppSessionQueueStore {
  constructor(
    private readonly db: Database,
    private readonly messageFiles: AppMessageFileStore,
    private readonly ensureChat: (sessionId: string) => void,
    private readonly controlsForMessageSend: (
      sessionId: string,
      input: Partial<SessionControlState>,
    ) => TurnControlResolution,
    private readonly admitVisualAttachments: (
      files: readonly import("../message-files/message-file-store.ts").MessageFileRow[],
      model: string,
    ) => Promise<VisualImageAdmissionResult | undefined>,
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
        client_message_id, input_identity_digest, control_resolution_json, safe_error_code,
        dispatched_message_id, turn_id,
        claim_id, claim_owner, claimed_at, lease_expires_at,
        terminal_result_message_id, created_at, updated_at
      FROM session_queued_messages
      WHERE chat_id = ?
        AND (
          state = 'queued'
          OR (state = 'failed' AND COALESCE(safe_error_code, '') <> 'turn_cancelled')
        )
      ORDER BY rowid ASC
    `,
      )
      .all(sessionId);
    return {
      session_id: sessionId,
      queued_messages: rows.map((row) => this.queuedMessageFromRow(row)),
    };
  }

  async createQueuedMessage(
    input: QueueMessageRequest,
    admittedVisual?: VisualImageAdmissionResult,
    admittedControls?: TurnControlResolution,
  ): Promise<SessionQueueView> {
    const chatId = input.chat_id?.trim() || DEFAULT_CHAT_ID;
    this.ensureChat(chatId);
    const text = (input.text ?? "").trim();
    const clientMessageId = stableClientMessageId(input.client_message_id);
    const existing = this.getQueuedMessageByClientId(chatId, clientMessageId);
    if (existing) {
      // An exact replay may arrive after admission has attached its files to
      // the user message. Compare the immutable file metadata without calling
      // validateAttachable(), whose one-shot admission guard correctly rejects
      // a new send of an already-consumed file.
      const replayFiles = (input.attachments ?? [])
        .map((attachment) => this.messageFiles.row(attachment.file_id?.trim() ?? ""))
        .filter((file): file is import("../message-files/message-file-store.ts").MessageFileRow => Boolean(file));
      const replayDigest = queuedInputIdentityDigest(input, text, replayFiles);
      const previousReplayMatches = existing.input_identity_digest ===
        queuedInputIdentityDigest(input, text, replayFiles, {
          includeSubsessionResult: false,
        });
      const legacyReplayMatches = existing.input_identity_digest ===
        legacyQueuedInputIdentityDigest(input, text, replayFiles) &&
        sameAttachmentIdentityOrder(
          requestedAttachmentIds(input),
          queuedAttachmentIds(existing.attachments_json),
        );
      if (existing.input_identity_digest !== replayDigest &&
        !previousReplayMatches && !legacyReplayMatches) {
        throw new AppStoreOperationError(
          409,
          "queued_message_identity_conflict",
          "This client message id was already accepted with different input.",
        );
      }
      return this.listSessionQueue(chatId);
    }
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
    const inputIdentityDigest = queuedInputIdentityDigest(input, text, attachableFiles);
    let reservation: {
      concurrent?: QueuedMessageRow | null;
      queuedId?: string;
      controlResolution?: TurnControlResolution;
    };
    try {
      reservation = this.db.transaction(() => {
        const concurrent = this.getQueuedMessageByClientId(chatId, clientMessageId);
        if (concurrent) return { concurrent };
        const resolvedControls = admittedControls ?? this.controlsForMessageSend(chatId, input);
        const controlResolution = {
          ...resolvedControls,
          ...(input.authority_request_ref
            ? { authority_request_ref: input.authority_request_ref }
            : {}),
          ...(input.subsession_result
            ? { subsession_result: input.subsession_result }
            : {}),
        };
        const now = new Date().toISOString();
        const queuedId = `queued-${crypto.randomUUID()}`;
        this.db
          .query(
            `
      INSERT INTO session_queued_messages (
        id, chat_id, text, client_message_id, input_identity_digest, control_resolution_json,
        controls_json, attachments_json,
        state, safe_error_code, dispatched_message_id, turn_id, claim_id,
        claim_owner, claimed_at, lease_expires_at, terminal_result_message_id,
        created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', NULL, NULL, NULL, NULL, NULL, NULL,
        NULL, NULL, ?, ?)
            `,
          )
          .run(
            queuedId,
            chatId,
            text,
            clientMessageId,
            inputIdentityDigest,
            JSON.stringify(controlResolution),
            JSON.stringify(controlResolution.controls),
            JSON.stringify(queueAttachmentPayload(attachableFiles)),
            now,
            now,
          );
        return { queuedId, controlResolution };
      })();
    } catch (error) {
      const concurrent = this.getQueuedMessageByClientId(chatId, clientMessageId);
      if (!concurrent) throw error;
      if (concurrent.input_identity_digest !== inputIdentityDigest) {
        throw new AppStoreOperationError(
          409,
          "queued_message_identity_conflict",
          "This client message id was already accepted with different input.",
        );
      }
      return this.listSessionQueue(chatId);
    }
    if (reservation.concurrent) {
      if (reservation.concurrent.input_identity_digest !== inputIdentityDigest) {
        throw new AppStoreOperationError(
          409,
          "queued_message_identity_conflict",
          "This client message id was already accepted with different input.",
        );
      }
      return this.listSessionQueue(chatId);
    }
    if (!reservation.queuedId || !reservation.controlResolution) {
      throw new Error("queued_message_reservation_missing");
    }
    let visualAdmission: VisualImageAdmissionResult | undefined;
    try {
      visualAdmission = admittedVisual ?? await this.admitVisualAttachments(
        attachableFiles,
        reservation.controlResolution.controls.model,
      );
    } catch (error) {
      const safeErrorCode = error instanceof AppStoreOperationError
        ? error.code
        : "queued_message_admission_failed";
      this.db.query(`
        UPDATE session_queued_messages
        SET state = 'failed', safe_error_code = ?, updated_at = ?
        WHERE id = ? AND state = 'queued'
      `).run(safeErrorCode, new Date().toISOString(), reservation.queuedId);
      this.appendEvent("session_queue.changed", {
        session_id: chatId,
        queued_message_id: reservation.queuedId,
        action: "failed",
        safe_error_code: safeErrorCode,
      });
      throw error;
    }
    this.db.query(`
      UPDATE session_queued_messages
      SET attachments_json = ?, updated_at = ?
      WHERE id = ? AND state = 'queued'
    `).run(
      JSON.stringify(queueAttachmentPayload(attachableFiles, visualAdmission)),
      new Date().toISOString(),
      reservation.queuedId,
    );
    this.appendEvent("session_queue.changed", {
      session_id: chatId,
      queued_message_id: reservation.queuedId,
      action: "created",
    });
    return this.listSessionQueue(chatId);
  }

  async updateQueuedMessage(
    queuedMessageId: string,
    input: UpdateQueuedMessageRequest,
  ): Promise<SessionQueueView> {
    const current = this.getQueuedMessageRow(queuedMessageId);
    if (!current || current.state !== "queued") {
      throw new AppStoreOperationError(
        404,
        "queued_message_not_found",
        "Queued message not found.",
      );
    }
    if (this.controlResolutionFromRow(current)?.authority_request_ref) {
      throw new AppStoreOperationError(
        409,
        "authority_queue_immutable",
        "Approved command queue entries cannot be edited.",
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
    const controlResolution = this.controlsForMessageSend(
      current.chat_id,
      { ...controls, ...input },
    );
    const visualAdmission = await this.admitVisualAttachments(
      attachableFiles,
      controlResolution.controls.model,
    );
    const inputIdentityDigest = queuedInputIdentityDigest(input, text, attachableFiles);
    const now = new Date().toISOString();
    this.db
      .query(
        `
      UPDATE session_queued_messages
      SET text = ?, control_resolution_json = ?, controls_json = ?,
        attachments_json = ?, input_identity_digest = ?, updated_at = ?
      WHERE id = ? AND state = 'queued'
    `,
      )
      .run(
        text,
        JSON.stringify(controlResolution),
        JSON.stringify(controlResolution.controls),
        JSON.stringify(queueAttachmentPayload(attachableFiles, visualAdmission)),
        inputIdentityDigest,
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
    if (!current || !["queued", "failed"].includes(current.state)) {
      throw new AppStoreOperationError(
        404,
        "queued_message_not_found",
        "Queued message not found.",
      );
    }
    if (this.controlResolutionFromRow(current)?.authority_request_ref) {
      throw new AppStoreOperationError(
        409,
        "authority_queue_immutable",
        "Approved command queue entries cannot be deleted.",
      );
    }
    const now = new Date().toISOString();
    this.db
      .query(
        `
      UPDATE session_queued_messages
      SET state = 'deleted', updated_at = ?
      WHERE id = ? AND state IN ('queued', 'failed')
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
      SELECT rowid, id, chat_id, text, client_message_id, input_identity_digest,
        control_resolution_json,
        controls_json,
        attachments_json, state, safe_error_code, dispatched_message_id, turn_id,
        claim_id, claim_owner, claimed_at, lease_expires_at,
        terminal_result_message_id, created_at, updated_at
      FROM session_queued_messages
      WHERE id = ?
    `,
        )
        .get(queuedMessageId) ?? null
    );
  }

  getQueuedMessageByClientId(
    chatId: string,
    clientMessageId: string,
  ): QueuedMessageRow | null {
    const stableId = stableClientMessageId(clientMessageId);
    return (
      this.db
        .query<QueuedMessageRow, [string, string]>(
          `
      SELECT rowid, id, chat_id, text, client_message_id, input_identity_digest,
        control_resolution_json,
        controls_json,
        attachments_json, state, safe_error_code, dispatched_message_id, turn_id,
        claim_id, claim_owner, claimed_at, lease_expires_at,
        terminal_result_message_id, created_at, updated_at
      FROM session_queued_messages
      WHERE chat_id = ? AND client_message_id = ?
    `,
        )
        .get(chatId, stableId) ?? null
    );
  }

  queuedMessageRecord(queuedMessageId: string): QueuedMessageRecord | null {
    const row = this.getQueuedMessageRow(queuedMessageId);
    return row ? this.queuedMessageFromRow(row) : null;
  }

  recoverExpiredDispatches(
    chatId?: string,
    now = new Date(),
    currentOwner?: string,
  ): number {
    const nowIso = now.toISOString();
    const query = `
      SELECT rowid, id, chat_id, text, client_message_id, input_identity_digest,
        control_resolution_json,
        controls_json,
        attachments_json, state, safe_error_code, dispatched_message_id, turn_id,
        claim_id, claim_owner, claimed_at, lease_expires_at,
        terminal_result_message_id, created_at, updated_at
      FROM session_queued_messages
      WHERE state = 'dispatching'
        AND (
          lease_expires_at IS NULL OR lease_expires_at <= ?
        )
        ${chatId ? "AND chat_id = ?" : ""}
      ORDER BY rowid ASC
    `;
    const queryArgs: string[] = chatId ? [nowIso, chatId] : [nowIso];
    const rows = this.db
      .query<QueuedMessageRow, typeof queryArgs>(query)
      .all(...queryArgs);
    const recoveryRows = currentOwner
      ? rows.concat(this.db.query<QueuedMessageRow, string[]>(`
          SELECT rowid, id, chat_id, text, client_message_id, input_identity_digest,
            control_resolution_json, controls_json, attachments_json, state,
            safe_error_code, dispatched_message_id, turn_id,
            claim_id, claim_owner, claimed_at, lease_expires_at,
            terminal_result_message_id, created_at, updated_at
          FROM session_queued_messages
          WHERE state = 'dispatching' AND claim_owner IS NOT NULL
            AND claim_owner <> ? AND (lease_expires_at IS NULL OR lease_expires_at > ?)
            ${chatId ? "AND chat_id = ?" : ""}
          ORDER BY rowid ASC
        `).all(
          ...(chatId ? [currentOwner, nowIso, chatId] : [currentOwner, nowIso]),
        ))
      : rows;
    const uniqueRows = new Map(recoveryRows.map((row) => [row.id, row]));
    let recoveredCount = 0;
    for (const row of uniqueRows.values()) {
      const ownerIsForeign = Boolean(
        currentOwner && row.claim_owner && row.claim_owner !== currentOwner,
      );
      const leaseExpired = !row.lease_expires_at ||
        Date.parse(row.lease_expires_at) <= now.getTime();
      if (
        ownerIsForeign &&
        !leaseExpired &&
        !definitelyDeadQueueOwner(row.claim_owner!, currentOwner)
      ) continue;
      const result = this.db
        .query(
          `
        UPDATE session_queued_messages
        SET state = 'queued', claim_id = NULL, claim_owner = NULL,
          claimed_at = NULL, lease_expires_at = NULL, updated_at = ?
        WHERE id = ? AND state = 'dispatching' AND claim_id IS ?
      `,
        )
        .run(nowIso, row.id, row.claim_id) as { changes: number };
      if (result.changes !== 1) continue;
      recoveredCount += 1;
      this.appendEvent("session_queue.changed", {
        session_id: row.chat_id,
        queued_message_id: row.id,
        action: "recovered",
        recovery_reason: "dispatch_lease_expired",
      });
    }
    return recoveredCount;
  }

  nextDispatchLeaseDeadline(
    currentOwner?: string,
    now = new Date(),
    chatId?: string,
  ): Date | null {
    const args: string[] = [now.toISOString()];
    const filters = [
      "state = 'dispatching'",
      "lease_expires_at IS NOT NULL",
      "lease_expires_at > ?",
    ];
    if (currentOwner) {
      filters.push("(claim_owner IS NULL OR claim_owner <> ?)");
      args.push(currentOwner);
    }
    if (chatId) {
      filters.push("chat_id = ?");
      args.push(chatId);
    }
    const row = this.db.query<{ lease_expires_at: string | null }, string[]>(`
      SELECT MIN(lease_expires_at) AS lease_expires_at
      FROM session_queued_messages
      WHERE ${filters.join(" AND ")}
    `).get(...args);
    if (!row?.lease_expires_at) return null;
    const deadline = Date.parse(row.lease_expires_at);
    return Number.isFinite(deadline) ? new Date(deadline) : null;
  }

  claimDispatch(
    chatId: string,
    queuedMessageId: string,
    claimId: string,
    claimOwner: string,
    now = new Date(),
    leaseMs = SESSION_QUEUE_LEASE_MS,
  ): QueuedMessageRow | null {
    const claimedAt = now.toISOString();
    const leaseExpiresAt = new Date(now.getTime() + Math.max(1, leaseMs)).toISOString();
    const result = this.db
      .query(
        `
      UPDATE session_queued_messages
      SET state = 'dispatching', claim_id = ?, claim_owner = ?, claimed_at = ?,
        lease_expires_at = ?, updated_at = ?
      WHERE id = ? AND chat_id = ? AND state = 'queued'
        AND NOT EXISTS (
          SELECT 1
          FROM session_queued_messages AS active
          WHERE active.chat_id = ? AND active.state = 'dispatching'
        )
    `,
      )
      .run(
        claimId,
        claimOwner,
        claimedAt,
        leaseExpiresAt,
        claimedAt,
        queuedMessageId,
        chatId,
        chatId,
      ) as { changes: number };
    if (result.changes !== 1) return null;
    this.appendEvent("session_queue.changed", {
      session_id: chatId,
      queued_message_id: queuedMessageId,
      action: "dispatching",
      lease_expires_at: leaseExpiresAt,
    });
    return this.getQueuedMessageRow(queuedMessageId);
  }

  recordDispatchResult(
    chatId: string,
    queuedMessageId: string,
    claimId: string,
    result: { messageId?: string; turnId?: string },
  ): boolean {
    const current = this.db.query<{
      state: string;
      dispatched_message_id: string | null;
      turn_id: string | null;
    }, [string, string]>(`
      SELECT state, dispatched_message_id, turn_id
      FROM session_queued_messages
      WHERE id = ? AND chat_id = ?
    `).get(queuedMessageId, chatId);
    if (current && ["dispatched", "failed"].includes(current.state) &&
      (!result.messageId || current.dispatched_message_id === result.messageId) &&
      (!result.turnId || current.turn_id === result.turnId)) return true;
    const updated = this.db
      .query(
        `
      UPDATE session_queued_messages
      SET dispatched_message_id = COALESCE(?, dispatched_message_id),
        turn_id = COALESCE(?, turn_id), updated_at = ?
      WHERE id = ? AND chat_id = ? AND state = 'dispatching' AND claim_id = ?
    `,
      )
      .run(
        result.messageId ?? null,
        result.turnId ?? null,
        new Date().toISOString(),
        queuedMessageId,
        chatId,
        claimId,
      ) as { changes: number };
    return updated.changes === 1;
  }

  acknowledgeForTurn(input: {
    chatId: string;
    turnId: string;
    claimId: string;
    resultMessageId?: string;
    safeErrorCode?: string | null;
  }): boolean {
    const state = input.safeErrorCode ? "failed" : "dispatched";
    const current = this.db.query<{
      state: string;
      terminal_result_message_id: string | null;
      safe_error_code: string | null;
    }, [string, string]>(`
      SELECT state, terminal_result_message_id, safe_error_code
      FROM session_queued_messages
      WHERE chat_id = ? AND turn_id = ?
    `).get(input.chatId, input.turnId);
    if (current &&
      ((state === "dispatched" && current.state === "dispatched") ||
        (state === "failed" && current.state === "failed")) &&
      current.terminal_result_message_id === (input.resultMessageId ?? null) &&
      current.safe_error_code === (input.safeErrorCode ?? null)) {
      return true;
    }
    const updated = this.db
      .query(
        `
      UPDATE session_queued_messages
      SET state = ?, terminal_result_message_id = ?, safe_error_code = ?,
        claim_id = NULL, claim_owner = NULL, claimed_at = NULL,
        lease_expires_at = NULL, updated_at = ?
      WHERE chat_id = ? AND turn_id = ?
        AND state = 'dispatching' AND claim_id = ?
    `,
      )
      .run(
        state,
        input.resultMessageId ?? null,
        input.safeErrorCode ?? null,
        new Date().toISOString(),
        input.chatId,
        input.turnId,
        input.claimId,
      ) as { changes: number };
    if (updated.changes === 0) return false;
    this.appendEvent("session_queue.changed", {
      session_id: input.chatId,
      turn_id: input.turnId,
      action: state === "failed" ? "failed" : "dispatched",
      ...(input.resultMessageId ? { result_message_id: input.resultMessageId } : {}),
      ...(input.safeErrorCode ? { safe_error_code: input.safeErrorCode } : {}),
    });
    return true;
  }

  failDispatch(
    chatId: string,
    queuedMessageId: string,
    claimId: string,
    safeErrorCode: string,
  ): boolean {
    const updated = this.db
      .query(
        `
      UPDATE session_queued_messages
      SET state = 'failed', safe_error_code = ?, claim_id = NULL,
        claim_owner = NULL, claimed_at = NULL, lease_expires_at = NULL,
        updated_at = ?
      WHERE id = ? AND chat_id = ? AND state = 'dispatching' AND claim_id = ?
    `,
      )
      .run(safeErrorCode, new Date().toISOString(), queuedMessageId, chatId, claimId) as { changes: number };
    if (updated.changes !== 1) return false;
    this.appendEvent("session_queue.changed", {
      session_id: chatId,
      queued_message_id: queuedMessageId,
      action: "failed",
      safe_error_code: safeErrorCode,
    });
    return true;
  }

  assertQueuedMessageClaim(
    chatId: string,
    queuedMessageId: string,
    claimId: string,
  ): boolean {
    return Boolean(this.db.query<{ id: string }, [string, string, string]>(`
      SELECT id
      FROM session_queued_messages
      WHERE id = ? AND chat_id = ? AND state = 'dispatching' AND claim_id = ?
    `).get(queuedMessageId, chatId, claimId));
  }

  claimIdForTurn(chatId: string, turnId: string): string | undefined {
    return this.db.query<{ claim_id: string | null }, [string, string]>(`
      SELECT claim_id
      FROM session_queued_messages
      WHERE chat_id = ? AND turn_id = ? AND state = 'dispatching'
    `).get(chatId, turnId)?.claim_id ?? undefined;
  }

  queuedTurnClaimStatus(
    chatId: string,
    turnId: string,
    claimId?: string,
  ): QueuedTurnClaimStatus {
    const row = this.db.query<{
      state: string;
      claim_id: string | null;
    }, [string, string]>(`
      SELECT state, claim_id
      FROM session_queued_messages
      WHERE chat_id = ? AND turn_id = ?
      ORDER BY rowid DESC
      LIMIT 1
    `).get(chatId, turnId);
    if (!row) return "unlinked";
    if (row.state === "dispatched" || row.state === "failed") return "terminal";
    if (row.state === "dispatching" && row.claim_id && row.claim_id === claimId) {
      return "current";
    }
    return "stale";
  }

  fenceQueuedTurnClaim(input: {
    chatId: string;
    turnId: string;
    claimId: string;
  }): boolean {
    const fenced = this.db.query(`
      UPDATE session_queued_messages
      SET updated_at = updated_at
      WHERE chat_id = ? AND turn_id = ? AND state = 'dispatching' AND claim_id = ?
    `).run(input.chatId, input.turnId, input.claimId) as { changes: number };
    return fenced.changes === 1;
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

  controlResolutionFromRow(
    row: QueuedMessageRow,
  ): TurnControlResolution | null {
    if (!row.control_resolution_json) return null;
    try {
      const parsed = JSON.parse(row.control_resolution_json) as TurnControlResolution;
      if (
        parsed &&
        typeof parsed === "object" &&
        parsed.controls &&
        typeof parsed.controls.model === "string" &&
        typeof parsed.sessionControlRevision === "number" &&
        typeof parsed.catalogGeneration === "string"
      ) return parsed;
    } catch {
      // Legacy rows are re-resolved by the caller.
    }
    return null;
  }

  queuedMessageFromRow(row: QueuedMessageRow): QueuedMessageRecord {
    const attachments = this.messageFiles.queuedRows(row).map(
      messageFileRefFromRow,
    );
    const record: QueuedMessageRecord = {
      id: row.id,
      chat_id: row.chat_id,
      text: row.text,
      ...(row.client_message_id
        ? { client_message_id: row.client_message_id }
        : {}),
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
    if (row.terminal_result_message_id) {
      record.terminal_result_message_id = row.terminal_result_message_id;
    }
    return record;
  }
}

function stableClientMessageId(value: string | undefined): string {
  const trimmed = value?.trim();
  if (trimmed && /^client-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  if (trimmed) {
    const digest = createHash("sha256").update(trimmed).digest("hex").slice(0, 32);
    return `client-${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20)}`;
  }
  return `client-${crypto.randomUUID()}`;
}

function queuedInputIdentityDigest(
  input: QueueMessageRequest | UpdateQueuedMessageRequest,
  text: string,
  files: readonly import("../message-files/message-file-store.ts").MessageFileRow[],
  options: { includeSubsessionResult?: boolean } = {},
): string {
  const requestedIds = requestedAttachmentIds(input);
  return createHash("sha256").update(JSON.stringify({
    version: requestedIds.length > 0 ? 2 : 1,
    text,
    explicit_controls: {
      model: input.model ?? null,
      reasoning_effort: input.reasoning_effort ?? null,
      access_mode: input.access_mode ?? null,
      plan_mode: input.plan_mode ?? null,
      authority_request_ref: input.authority_request_ref ?? null,
      ...(options.includeSubsessionResult !== false && input.subsession_result
        ? { subsession_result: input.subsession_result }
        : {}),
    },
    admission_identity: files.map((file) => ({
      id: file.id,
      kind: file.kind,
      mime_type: file.mime_type,
      safe_name: file.safe_name,
      size_bytes: file.size_bytes,
      sha256: file.sha256,
    })),
    ...(requestedIds.length > 0 ? { requested_attachment_ids: requestedIds } : {}),
  })).digest("hex");
}

function legacyQueuedInputIdentityDigest(
  input: QueueMessageRequest | UpdateQueuedMessageRequest,
  text: string,
  files: readonly import("../message-files/message-file-store.ts").MessageFileRow[],
): string {
  return createHash("sha256").update(JSON.stringify({
    version: 1,
    text,
    explicit_controls: {
      model: input.model ?? null,
      reasoning_effort: input.reasoning_effort ?? null,
      access_mode: input.access_mode ?? null,
      plan_mode: input.plan_mode ?? null,
    },
    admission_identity: files.map((file) => ({
      id: file.id,
      kind: file.kind,
      mime_type: file.mime_type,
      safe_name: file.safe_name,
      size_bytes: file.size_bytes,
      sha256: file.sha256,
    })),
  })).digest("hex");
}

function requestedAttachmentIds(
  input: QueueMessageRequest | UpdateQueuedMessageRequest,
): string[] {
  return (input.attachments ?? []).map((attachment) =>
    attachment.file_id?.trim() ?? "");
}

function queuedAttachmentIds(attachmentsJson: string): string[] {
  try {
    const attachments = JSON.parse(attachmentsJson) as unknown;
    if (!Array.isArray(attachments)) return [];
    return attachments.map((attachment) => {
      if (typeof attachment === "string") return attachment;
      if (attachment && typeof attachment === "object" &&
        typeof (attachment as { file_id?: unknown }).file_id === "string") {
        return (attachment as { file_id: string }).file_id;
      }
      return "";
    });
  } catch {
    return [];
  }
}

function sameAttachmentIdentityOrder(
  requested: readonly string[],
  stored: readonly string[],
): boolean {
  return requested.length === stored.length &&
    requested.every((fileId, index) => fileId === stored[index]);
}

function definitelyDeadQueueOwner(owner: string, currentOwner?: string): boolean {
  const match = /^app-session-queue:(\d+):([^:]+)(?::[^:]+)?$/u.exec(owner);
  if (!match) return false;
  const pid = Number(match[1]);
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  const ownerParts = owner.split(":");
  const ownerIncarnation = ownerParts.length === 4 ? match[2] : undefined;
  const currentMatch = /^app-session-queue:(\d+):([^:]+)(?::[^:]+)?$/u.exec(currentOwner ?? "");
  const currentPid = currentMatch?.[1];
  if (currentPid && Number(currentPid) === pid) {
    const currentParts = (currentOwner ?? "").split(":");
    const currentIncarnation = currentParts.length === 4
      ? currentMatch?.[2]
      : undefined;
    if (ownerIncarnation && currentIncarnation) {
      if (ownerIncarnation !== currentIncarnation) return true;
      return !LIVE_QUEUE_OWNERS.has(owner);
    }
  }
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}
