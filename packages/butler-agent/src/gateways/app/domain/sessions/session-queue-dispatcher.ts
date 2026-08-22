import { Database } from "bun:sqlite";
import { AppStoreOperationError } from "../../infrastructure/core/app-store-errors.ts";
import type { QueuedMessageRow } from "../../infrastructure/core/records.ts";
import type {
  MessageSendResult,
  SessionControlState,
} from "../../interface/protocol/app-protocol.ts";
import type {
  AppMessageResponder,
  SendMessageOptions,
} from "./message-responder-contract.ts";
import type { VisualImageAdmissionResult } from "../../../../agent/image-attachment/contracts.ts";
import type { TurnControlResolution } from "../../../core/turn-execution-controls.ts";
import {
  SESSION_QUEUE_LEASE_MS,
  createQueueOwner,
  registerQueueOwner,
  unregisterQueueOwner,
} from "./session-queue-store.ts";

export class AppSessionQueueDispatcher {
  private readonly claimOwner = createQueueOwner();
  private recoveryWakeTimer: ReturnType<typeof setTimeout> | undefined;
  private recoveryInFlight: Promise<void> | undefined;
  private closed = false;

  constructor(
    private readonly input: {
      db: Database;
      sessionHasActiveTurn: (sessionId: string) => boolean;
      queuedControlsFromRow: (row: QueuedMessageRow) => SessionControlState;
      controlResolutionFromRow: (row: QueuedMessageRow) => TurnControlResolution | null;
      sendQueuedMessage: (
        row: QueuedMessageRow,
        responder?: AppMessageResponder,
        options?: SendMessageOptions,
        visualAdmission?: VisualImageAdmissionResult,
      ) => Promise<MessageSendResult>;
      recoverExpiredDispatches: (
        chatId?: string,
        now?: Date,
        currentOwner?: string,
      ) => number;
      nextDispatchLeaseDeadline: (
        currentOwner?: string,
        now?: Date,
      ) => Date | null;
      claimDispatch: (
        chatId: string,
        queuedMessageId: string,
        claimId: string,
        claimOwner: string,
        now?: Date,
        leaseMs?: number,
      ) => QueuedMessageRow | null;
      recordDispatchResult: (
        chatId: string,
        queuedMessageId: string,
        claimId: string,
        result: { messageId?: string; turnId?: string },
      ) => boolean;
      getTurn: (turnId: string) => MessageSendResult["turn"];
      acknowledgeQueuedMessageForTurn: (input: {
        chatId: string;
        turnId: string;
        claimId: string;
        resultMessageId?: string;
        safeErrorCode?: string | null;
      }) => boolean;
      terminalResultMessageIdForTurn: (chatId: string, turnId: string) => string | undefined;
      failDispatch: (
        chatId: string,
        queuedMessageId: string,
        claimId: string,
        safeErrorCode: string,
      ) => boolean;
      validateVisualAdmission: (
        admission: VisualImageAdmissionResult,
        model: string,
      ) => Promise<VisualImageAdmissionResult>;
    },
  ) {
    registerQueueOwner(this.claimOwner, () => this.wakeRecovery());
  }

  close(): void {
    this.closed = true;
    if (this.recoveryWakeTimer) clearTimeout(this.recoveryWakeTimer);
    this.recoveryWakeTimer = undefined;
    unregisterQueueOwner(this.claimOwner);
  }

  async drain(
    chatId: string,
    responder?: AppMessageResponder,
    options: SendMessageOptions = {},
    targetQueuedMessageId?: string,
  ): Promise<MessageSendResult | undefined> {
    this.input.recoverExpiredDispatches(chatId);
    const rows = this.input.db
      .query<QueuedMessageRow, [string]>(
        `
      SELECT rowid, id, chat_id, text, client_message_id, input_identity_digest,
        control_resolution_json, controls_json,
        attachments_json, state, safe_error_code, dispatched_message_id, turn_id,
        claim_id, claim_owner, claimed_at, lease_expires_at,
        terminal_result_message_id, created_at, updated_at
      FROM session_queued_messages
      WHERE chat_id = ? AND state = 'queued'
      ORDER BY rowid ASC
      LIMIT 20
    `,
      )
      .all(chatId);
    let targetResult: MessageSendResult | undefined;
    for (const row of rows) {
      if (
        this.input.sessionHasActiveTurn(chatId) &&
        !isActiveLinkedTurn(this.input.getTurn, row.turn_id)
      ) return targetResult;
      const claim = this.input.claimDispatch(
        chatId,
        row.id,
        crypto.randomUUID(),
        this.claimOwner,
        new Date(),
        SESSION_QUEUE_LEASE_MS,
      );
      if (!claim) continue;
      try {
        const controls = this.input.controlResolutionFromRow(claim)?.controls ??
          this.input.queuedControlsFromRow(claim);
        const visualAdmission = parseQueuedVisualAdmission(claim.attachments_json);
        const validatedVisual = visualAdmission
          ? await this.input.validateVisualAdmission(visualAdmission, controls.model)
          : undefined;
        const result = await this.input.sendQueuedMessage(
          claim,
          responder,
          options,
          validatedVisual,
        );
        if (!claim.claim_id || !this.input.recordDispatchResult(chatId, claim.id, claim.claim_id, {
          messageId: result.accepted?.id,
          turnId: result.turn?.id,
        })) throw new Error("queued_message_claim_lost");
        const currentTurn = result.turn
          ? this.input.getTurn(result.turn.id)
          : undefined;
        if (currentTurn && isTerminalTurnState(currentTurn.state)) {
          const settled = this.input.acknowledgeQueuedMessageForTurn({
            chatId,
            turnId: currentTurn.id,
            claimId: claim.claim_id!,
            resultMessageId: result.replies.at(-1)?.id ??
              this.input.terminalResultMessageIdForTurn(chatId, currentTurn.id),
            ...(currentTurn.state === "failed" || currentTurn.state === "runtime_fault"
              ? { safeErrorCode: currentTurn.safe_error_code ?? "queued_message_dispatch_failed" }
              : {}),
          });
          if (settled) await this.drain(chatId, responder, options).catch(() => undefined);
        }
        if (targetQueuedMessageId === claim.id) targetResult = result;
      } catch (error) {
        if (isClaimLostError(error)) continue;
        const safeErrorCode = safeQueueDispatchErrorCode(error);
        const failedTurn = failedTurnFromError(error);
        if (!failedTurn) {
          if (claim.claim_id) {
            const failed = this.input.failDispatch(chatId, claim.id, claim.claim_id, safeErrorCode);
            if (failed) await this.drain(chatId, responder, options).catch(() => undefined);
          }
          continue;
        }
        if (!claim.claim_id || !this.input.recordDispatchResult(chatId, claim.id, claim.claim_id, {
          messageId: failedTurn.user_message_id,
          turnId: failedTurn.id,
        })) continue;
        const settled = this.input.acknowledgeQueuedMessageForTurn({
          chatId,
          turnId: failedTurn.id,
          claimId: claim.claim_id,
          resultMessageId: this.input.terminalResultMessageIdForTurn(
            chatId,
            failedTurn.id,
          ),
          safeErrorCode: failedTurn.safe_error_code ?? safeErrorCode,
        });
        if (settled) await this.drain(chatId, responder, options).catch(() => undefined);
      }
      if (targetResult) return targetResult;
    }
    return targetResult;
  }

  async recoverAndDrain(): Promise<void> {
    if (this.closed) return;
    if (this.recoveryInFlight) return this.recoveryInFlight;
    const run = (async () => {
      this.input.recoverExpiredDispatches(undefined, new Date(), this.claimOwner);
      const sessions = this.input.db
        .query<{ chat_id: string }, []>(`
          SELECT chat_id
          FROM session_queued_messages
          WHERE state = 'queued'
          GROUP BY chat_id
          ORDER BY MIN(rowid) ASC
        `)
        .all();
      for (const session of sessions) {
        await this.drain(session.chat_id);
      }
      this.scheduleLeaseWake();
    })();
    this.recoveryInFlight = run;
    try {
      await run;
    } finally {
      if (this.recoveryInFlight === run) this.recoveryInFlight = undefined;
    }
  }

  private wakeRecovery(): void {
    if (this.closed) return;
    void this.recoverAndDrain().catch(() => undefined);
  }

  private scheduleLeaseWake(): void {
    if (this.closed) return;
    if (this.recoveryWakeTimer) clearTimeout(this.recoveryWakeTimer);
    this.recoveryWakeTimer = undefined;
    const deadline = this.input.nextDispatchLeaseDeadline(
      this.claimOwner,
      new Date(),
    );
    if (!deadline) return;
    const delay = Math.max(0, deadline.getTime() - Date.now());
    this.recoveryWakeTimer = setTimeout(() => {
      this.recoveryWakeTimer = undefined;
      this.wakeRecovery();
    }, delay);
  }

}

function isTerminalTurnState(state: string): boolean {
  return ["delivered", "failed", "cancelled", "runtime_fault"].includes(state);
}

function isActiveLinkedTurn(
  getTurn: (turnId: string) => MessageSendResult["turn"],
  turnId: string | null,
): boolean {
  if (!turnId) return false;
  try {
    const turn = getTurn(turnId);
    return Boolean(turn && [
      "accepted",
      "thinking",
      "streaming",
      "waiting_for_form",
      "waiting_for_tool",
      "cancelling",
      "retrying",
    ].includes(turn.state));
  } catch {
    return false;
  }
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

function failedTurnFromError(
  error: unknown,
): MessageSendResult["turn"] | undefined {
  if (!error || typeof error !== "object" || !("turn" in error)) return undefined;
  const turn = (error as { turn?: MessageSendResult["turn"] }).turn;
  return turn?.id ? turn : undefined;
}

function isClaimLostError(error: unknown): boolean {
  return error instanceof Error && error.message === "queued_message_claim_lost";
}
