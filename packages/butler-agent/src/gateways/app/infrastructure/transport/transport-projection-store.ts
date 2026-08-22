import {
  FIRST_VISIBLE_PROGRESS_EVENT_KIND,
} from "../../../../agent/events/turn-events.ts";
import type { TranscriptEvent } from "../../../../test-support/harness/transcripts.ts";
import type { TurnState } from "../../interface/protocol/app-protocol.ts";
import {
  shouldProjectRecoverableLimitedFinalOverTerminalTurn,
} from "./app-delivery-projection.ts";
import {
  progressRowFromAppOutbound,
} from "./app-transport-projection.ts";
import {
  isAppWorkerResultOutbound,
  runtimeTurnEventFromAppOutboundMetadata,
} from "./app-transport-metadata.ts";
import {
  isRecord,
  safeOptionalShortText,
  safeOptionalShortToken,
} from "../core/projection-safe-values.ts";
import { TURN_ACKNOWLEDGED_EVENT_KIND } from "../../../../agent/events/turn-state-contract.ts";
import { AppTransportTranscriptSyncStore } from "./transcript-sync-store.ts";
import { AppProjectedTransportEventStore } from "./projected-transport-event-store.ts";
import {
  queuedFinalProjectionDisposition,
  recoverableLimitedFinalForFailedQueueDisposition,
} from "./inbound-queue-terminal-records.ts";
import {
  isSameDeliveredFinalProjection,
  projectAppFinalResult,
} from "./final-result-projection.ts";
import { projectAppTurnFailure } from "./projected-turn-failure.ts";
import { projectAppWorkerResult } from "./worker-result-projection.ts";
import type {
  AppTransportProjectionStoreOptions,
} from "./transport-projection-contract.ts";
import { subsessionResultStatusLabel } from "../../../core/turn-execution-controls.ts";
import { StagedTransportOutboundStore } from
  "./staged-transport-outbound-store.ts";
import { OPERATION_OUTPUT_CHUNK_EVENT_KIND } from
  "../../../../agent/events/operation-output-event.ts";
import { AppOperationOutputProjectionStore } from
  "../operation-output/app-operation-output-projection-store.ts";
import {
  projectAppCancellationAck,
  projectAppCancellationTerminal,
} from "./cancellation-projection.ts";
import { projectClaimedOutbound } from "./claimed-outbound-projection.ts";

export class AppTransportProjectionStore {
  private readonly transcriptSync: AppTransportTranscriptSyncStore;
  private readonly projectedEvents: AppProjectedTransportEventStore;
  private readonly stagedOutbounds: StagedTransportOutboundStore;
  private readonly operationOutputs: AppOperationOutputProjectionStore;
  private transcriptCycleComplete = false;
  private deferredCycleComplete = false;
  private deferredFinalCursor = "";

  constructor(private readonly options: AppTransportProjectionStoreOptions) {
    this.projectedEvents = new AppProjectedTransportEventStore(options.db);
    this.operationOutputs = new AppOperationOutputProjectionStore(options.db);
    this.stagedOutbounds = new StagedTransportOutboundStore(options.db);
    this.transcriptSync = new AppTransportTranscriptSyncStore({
      db: options.db,
      butlerData: options.butlerData,
      projectDeliveryEvent: (event) => this.projectAppDeliveryEvent(event),
      projectOutboundEvent: (chatId, event) =>
        this.projectAppOutboundEvent(chatId, event),
      recordDiagnostic: (diagnostic) => options.appendEvent(
        "app.transport_projection.diagnostic",
        {
          chat_id: diagnostic.chatId,
          byte_offset: diagnostic.byteOffset,
          code: diagnostic.code,
        },
      ),
    });
  }

  syncNextBatch(): boolean {
    const transcript = this.transcriptCycleComplete
      ? { applied: 0, pending: false }
      : this.transcriptSync.syncNextBatch();
    this.transcriptCycleComplete = !transcript.pending;
    const transcriptPending = transcript.pending;
    const deferredPending = this.deferredCycleComplete
      ? false
      : this.reconcileDeferredQueuedFinalOutboundBatch();
    this.deferredCycleComplete = !deferredPending;
    if (
      transcriptPending || deferredPending
    ) return true;
    this.resetBatchCycle();
    return false;
  }

  syncTranscriptFile(fileName: string): boolean {
    return this.transcriptSync.syncTranscriptFile(fileName).pending;
  }

  openTurnTranscriptFiles(): string[] {
    return this.transcriptSync.openTurnTranscriptFiles();
  }

  syncDeferredNextBatch(): boolean {
    const pending = this.reconcileDeferredQueuedFinalOutboundBatch();
    this.deferredCycleComplete = !pending;
    return pending;
  }

  reopenCompletedLiveLanes(): void {
    if (this.deferredCycleComplete) this.deferredFinalCursor = "";
    this.transcriptCycleComplete = false;
    this.deferredCycleComplete = false;
  }

  private resetBatchCycle(): void {
    this.transcriptCycleComplete = false;
    this.deferredCycleComplete = false;
    this.deferredFinalCursor = "";
  }

  private projectAppOutboundEvent(
    chatId: string,
    event: TranscriptEvent,
    deliveryState: "pending" | "delivered" = "pending",
  ): boolean {
    const payload = event.payload;
    const actionId = safeOptionalShortText(payload.actionId);
    const message = isRecord(payload.message) ? payload.message : {};
    const metadata = isRecord(payload.metadata) ? payload.metadata : {};
    if (
      actionId &&
      this.hasProjectedTransportEvent(actionId) &&
      !safeOptionalShortToken(metadata.appQueueClaimId)
    ) return false;
    if (isAppWorkerResultOutbound(metadata)) {
      return projectAppWorkerResult({
        options: this.options,
        hasProjectedTransportEvent: (id) => this.hasProjectedTransportEvent(id),
        markProjectedTransportEvent: (id, eventId, targetChatId) =>
          this.markProjectedTransportEvent(id, eventId, targetChatId),
        chatId,
        event,
        actionId,
        message,
      });
    }
    const turnId = this.turnIdForAppOutbound(chatId, metadata, message);
    if (!actionId || !turnId) return false;
    const turn = this.options.getTurnRow(turnId);
    if (!turn) return false;
    const claimStatus = this.options.queuedTurnClaimStatus(
      chatId,
      turnId,
      safeOptionalShortToken(metadata.appQueueClaimId),
    );
    if (claimStatus === "stale") return false;
    if (claimStatus === "terminal") {
      this.markProjectedTransportEvent(actionId, event.eventId, chatId);
      return false;
    }
    const cancellationAck = projectAppCancellationAck({
      options: this.options,
      chatId,
      turnId,
      actionId,
      event,
      metadata,
      deliveryState,
      stage: () => {
        const claimId = safeOptionalShortToken(metadata.appQueueClaimId);
        const staged = { actionId, chatId, event, state: "awaiting_delivery" as const };
        if (claimId) this.stagedOutbounds.stageClaimed(staged, claimId);
        else this.stagedOutbounds.stage(staged);
      },
      markProjected: () =>
        this.markProjectedTransportEvent(actionId, event.eventId, chatId),
    });
    if (cancellationAck !== null) return cancellationAck;
    const turnEvent = runtimeTurnEventFromAppOutboundMetadata(metadata);
    if (turnEvent) {
      const claimId = safeOptionalShortToken(metadata.appQueueClaimId);
      if (deliveryState !== "delivered") {
        return projectClaimedOutbound(
          this.options,
          { chatId, turnId, metadata },
          () => {
            const staged = {
              actionId,
              chatId,
              event,
              state: "awaiting_delivery" as const,
            };
            if (claimId) this.stagedOutbounds.stageClaimed(staged, claimId);
            else this.stagedOutbounds.stage(staged);
            return false;
          },
        );
      }
      const projectTurnEvent = (): boolean => {
        if (turnEvent.kind === OPERATION_OUTPUT_CHUNK_EVENT_KIND) {
          const projected = this.operationOutputs.project({
            turnId,
            payload: turnEvent.payload ?? {},
          });
          this.markProjectedTransportEvent(actionId, event.eventId, chatId);
          return projected;
        }
        const alreadyProjectedReceipt =
          (turnEvent.kind === TURN_ACKNOWLEDGED_EVENT_KIND ||
            turnEvent.kind === FIRST_VISIBLE_PROGRESS_EVENT_KIND) &&
          this.options.hasTurnEventKind(turnId, turnEvent.kind);
        if (!alreadyProjectedReceipt)
          this.options.appendTurnEvent(chatId, turnId, turnEvent);
        const runtimeFaultProjected = turnEvent.kind === "runtime.fault"
          ? projectAppTurnFailure({
              options: this.options,
              chatId,
              turnId,
              message: { text: turnEvent.payload?.publicSummary },
              metadata: { ...metadata, safeErrorCode: "runtime_fault" },
              eventTimestamp: event.timestamp,
              claimFenceAlreadyHeld: true,
            })
          : false;
        const cancellationProjected = turnEvent.kind === "turn.cancelled"
          ? projectAppCancellationTerminal({
            options: this.options,
            chatId,
            turnId,
            timestamp: event.timestamp,
            metadata,
            claimFenceAlreadyHeld: true,
          })
          : false;
        const runtimeFaultSettlementBlocked = turnEvent.kind === "runtime.fault" &&
          !runtimeFaultProjected &&
          queuedSettlementRequired(this.options, chatId, turnId, {
            ...metadata,
            safeErrorCode: "runtime_fault",
          });
        if (!runtimeFaultSettlementBlocked) {
          this.markProjectedTransportEvent(actionId, event.eventId, chatId);
        }
        if (!alreadyProjectedReceipt) this.options.touchChat(chatId);
        return !alreadyProjectedReceipt || cancellationProjected || runtimeFaultProjected;
      };
      const projectTurnEventAndDeleteStage = (): boolean => {
        const projected = projectTurnEvent();
        if (deliveryState === "delivered") this.stagedOutbounds.delete(actionId);
        return projected;
      };
      if (!claimId || claimStatus === "unlinked") return projectTurnEventAndDeleteStage();
      return this.options.db.transaction(() => {
        if (!this.options.fenceQueuedTurnClaim({ chatId, turnId, claimId })) return false;
        return projectTurnEventAndDeleteStage();
      })();
    }

    let terminalRecoverableCorrection = false;
    if (isTerminalTurnStateForProjection(turn.state)) {
      const sameDeliveredFinal = metadata.kind === "final_result" &&
        turn.state === "delivered" &&
        isSameDeliveredFinalProjection({
          options: this.options,
          turnId,
          turnState: turn.state,
          message,
        });
      if (
        !sameDeliveredFinal &&
        (
          !shouldProjectRecoverableLimitedFinalOverTerminalTurn(turn, metadata) ||
          recoverableLimitedFinalForFailedQueueDisposition({
            butlerData: this.options.butlerData,
            metadata,
          }) !== "accept"
        )
      ) {
        this.markProjectedTransportEvent(actionId, event.eventId, chatId);
        return false;
      }
      terminalRecoverableCorrection = !sameDeliveredFinal;
    }

    const rawProgressRow = progressRowFromAppOutbound(
      actionId,
      message,
      metadata,
      event.timestamp,
    );
    const synthesis = this.options.getTurn(turnId).execution_controls
      ?.subsession_result;
    const progressRow = rawProgressRow && synthesis &&
        rawProgressRow.kind === "message" && !rawProgressRow.safe_tool_name
      ? { ...rawProgressRow, safe_label: subsessionResultStatusLabel(synthesis) }
      : rawProgressRow;
    if (progressRow) {
      return projectClaimedOutbound(
        this.options,
        { chatId, turnId, metadata },
        () => {
          if (this.hasProjectedTransportEvent(actionId)) return false;
          const projected = !this.options.hasEquivalentProgressSummaryRow(
            turnId,
            progressRow,
          );
          if (projected)
            this.options.appendProgressSummaryEvent(chatId, turnId, progressRow);
          this.markProjectedTransportEvent(actionId, event.eventId, chatId);
          this.options.touchChat(chatId);
          return projected;
        },
      );
    }

    if (metadata.kind === "turn_cancelled") {
      if (this.hasProjectedTransportEvent(actionId)) return false;
      const projected = projectAppCancellationTerminal({
        options: this.options,
        chatId,
        turnId,
        timestamp: event.timestamp,
        metadata,
      });
      if (projected) {
        this.markProjectedTransportEvent(actionId, event.eventId, chatId);
        this.options.touchChat(chatId);
        void this.options.drainQueuedSessionMessages(chatId).catch(() => undefined);
      }
      return projected;
    }

    if (metadata.kind === "turn_failed") {
      if (this.hasProjectedTransportEvent(actionId)) return false;
      const projected = projectAppTurnFailure({
        options: this.options,
        chatId,
        turnId,
        message,
        metadata,
        eventTimestamp: event.timestamp,
      });
      if (
        projected ||
        !queuedSettlementRequired(this.options, chatId, turnId, metadata)
      ) {
        this.markProjectedTransportEvent(actionId, event.eventId, chatId);
      }
      return projected;
    }

    if (metadata.kind !== "final_result") return false;
    const queuedFinalProjection = queuedFinalProjectionDisposition({
      butlerData: this.options.butlerData,
      metadata,
    });
    if (queuedFinalProjection === "defer") {
      const claimId = safeOptionalShortToken(metadata.appQueueClaimId);
      return projectClaimedOutbound(
        this.options,
        { chatId, turnId, metadata },
        () => {
          const staged = {
            actionId,
            chatId,
            event,
            state: "deferred_final" as const,
          };
          if (claimId) this.stagedOutbounds.stageClaimed(staged, claimId);
          else this.stagedOutbounds.stage(staged);
          return false;
        },
      );
    }
    return projectAppFinalResult({
      options: this.options,
      markProjectedTransportEvent: (id, eventId, targetChatId) =>
        this.markProjectedTransportEvent(id, eventId, targetChatId),
      chatId,
      turnId,
      actionId,
      event,
      message,
      metadata,
      terminalRecoverableCorrection,
      queuedFinalProjection,
      deleteStagedOutbound: () => this.stagedOutbounds.delete(actionId),
    });
  }

  private reconcileDeferredQueuedFinalOutboundBatch(): boolean {
    const batch = this.stagedOutbounds.listDeferredBatch(
      this.deferredFinalCursor,
    );
    for (const pending of batch.rows) {
      if (this.hasProjectedTransportEvent(pending.actionId)) {
        this.deleteStagedOutboundForPending(pending);
        continue;
      }
      this.projectAppOutboundEvent(pending.chatId, pending.event);
      if (this.hasProjectedTransportEvent(pending.actionId)) {
        this.deleteStagedOutboundForPending(pending);
      }
    }
    this.deferredFinalCursor = batch.pending ? batch.nextCursor : "";
    return batch.pending;
  }

  private projectAppDeliveryEvent(event: TranscriptEvent): boolean {
    const actionId = safeOptionalShortText(event.payload.actionId);
    if (!actionId) return false;
    const pending = this.stagedOutbounds.load(actionId);
    if (!pending || pending.state !== "awaiting_delivery") return false;
    if (event.payload.ok !== true) {
      return this.deleteStagedOutboundForPending(pending);
    }
    if (this.hasProjectedTransportEvent(actionId)) {
      return this.deleteStagedOutboundForPending(pending);
    }
    const projected = this.projectAppOutboundEvent(
      pending.chatId,
      pending.event,
      "delivered",
    );
    const deleted = this.deleteStagedOutboundForPending(pending);
    return projected || deleted;
  }

  private deleteStagedOutboundForPending(
    pending: { actionId: string; chatId: string; event: TranscriptEvent },
  ): boolean {
    const metadata = isRecord(pending.event.payload.metadata)
      ? pending.event.payload.metadata
      : {};
    const turnId = this.turnIdForAppOutbound(
      pending.chatId,
      metadata,
      isRecord(pending.event.payload.message)
        ? pending.event.payload.message
        : {},
    );
    const claimId = safeOptionalShortToken(metadata.appQueueClaimId);
    if (!claimId) {
      this.stagedOutbounds.delete(pending.actionId);
      return true;
    }
    if (!turnId) return false;
    return projectClaimedOutbound(
      this.options,
      { chatId: pending.chatId, turnId, metadata },
      () => {
        this.stagedOutbounds.delete(pending.actionId);
        return true;
      },
    );
  }

  private hasProjectedTransportEvent(actionId: string): boolean {
    return this.projectedEvents.has(actionId);
  }

  private markProjectedTransportEvent(
    actionId: string,
    eventId: string,
    chatId: string,
  ): void {
    this.projectedEvents.mark(actionId, eventId, chatId);
  }

  private turnIdForAppOutbound(
    chatId: string,
    metadata: Record<string, unknown>,
    message: Record<string, unknown>,
  ): string | null {
    const explicitTurnId = safeOptionalShortToken(metadata.turnId);
    if (explicitTurnId) return explicitTurnId;
    const replyToMessageId = safeOptionalShortText(message.replyToMessageId);
    if (!replyToMessageId) return null;
    const row = this.options.db
      .query<{ id: string }, [string, string]>(
        `
      SELECT id
      FROM turns
      WHERE chat_id = ? AND user_message_id = ?
      ORDER BY rowid DESC
      LIMIT 1
    `,
      )
      .get(chatId, replyToMessageId);
    return row?.id ?? null;
  }
}

function isTerminalTurnStateForProjection(state: TurnState): boolean {
  return ["delivered", "failed", "cancelled", "runtime_fault"].includes(state);
}

function queuedSettlementRequired(
  options: AppTransportProjectionStoreOptions,
  chatId: string,
  turnId: string,
  metadata: Record<string, unknown>,
): boolean {
  return options.queuedTurnClaimStatus(
    chatId,
    turnId,
    safeOptionalShortToken(metadata.appQueueClaimId),
  ) !== "unlinked";
}
