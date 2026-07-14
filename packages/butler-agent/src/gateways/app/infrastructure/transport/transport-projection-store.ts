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
import { projectAppFinalResult } from "./final-result-projection.ts";
import { projectAppTurnFailure } from "./projected-turn-failure.ts";
import { projectAppWorkerResult } from "./worker-result-projection.ts";
import type {
  AppTransportProjectionStoreOptions,
} from "./transport-projection-contract.ts";

interface PendingAppTurnEventOutbound {
  chatId: string;
  event: TranscriptEvent;
}

type DeferredQueuedFinalOutbound = PendingAppTurnEventOutbound;

export class AppTransportProjectionStore {
  private readonly transcriptSync: AppTransportTranscriptSyncStore;
  private readonly projectedEvents: AppProjectedTransportEventStore;
  private readonly pendingAppTurnEventOutbounds = new Map<
    string,
    PendingAppTurnEventOutbound
  >();
  private readonly deferredQueuedFinalOutbounds = new Map<
    string,
    DeferredQueuedFinalOutbound
  >();

  constructor(private readonly options: AppTransportProjectionStoreOptions) {
    this.projectedEvents = new AppProjectedTransportEventStore(options.db);
    this.transcriptSync = new AppTransportTranscriptSyncStore({
      db: options.db,
      butlerData: options.butlerData,
      projectDeliveryEvent: (event) => this.projectAppDeliveryEvent(event),
      projectOutboundEvent: (chatId, event) =>
        this.projectAppOutboundEvent(chatId, event),
    });
  }

  syncAll(): number {
    const transcriptProjectionCount = this.transcriptSync.syncAll();
    return (
      transcriptProjectionCount + this.reconcileDeferredQueuedFinalOutbounds()
    );
  }

  syncChat(chatId: string): number {
    const transcriptProjectionCount = this.transcriptSync.syncChat(chatId);
    return (
      transcriptProjectionCount +
      this.reconcileDeferredQueuedFinalOutbounds(chatId)
    );
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
    if (actionId && this.hasProjectedTransportEvent(actionId)) return false;
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
    const turnEvent = runtimeTurnEventFromAppOutboundMetadata(metadata);
    if (turnEvent) {
      if (deliveryState !== "delivered") {
        this.pendingAppTurnEventOutbounds.set(actionId, { chatId, event });
        return false;
      }
      const alreadyProjectedReceipt =
        (turnEvent.kind === TURN_ACKNOWLEDGED_EVENT_KIND ||
          turnEvent.kind === FIRST_VISIBLE_PROGRESS_EVENT_KIND) &&
        this.options.hasTurnEventKind(turnId, turnEvent.kind);
      if (!alreadyProjectedReceipt)
        this.options.appendTurnEvent(chatId, turnId, turnEvent);
      this.markProjectedTransportEvent(actionId, event.eventId, chatId);
      if (!alreadyProjectedReceipt) this.options.touchChat(chatId);
      return !alreadyProjectedReceipt;
    }

    let terminalRecoverableCorrection = false;
    if (isTerminalTurnStateForProjection(turn.state)) {
      if (
        !shouldProjectRecoverableLimitedFinalOverTerminalTurn(turn, metadata) ||
        recoverableLimitedFinalForFailedQueueDisposition({
          butlerData: this.options.butlerData,
          metadata,
        }) !==
          "accept"
      ) {
        this.markProjectedTransportEvent(actionId, event.eventId, chatId);
        return false;
      }
      terminalRecoverableCorrection = true;
    }

    const progressRow = progressRowFromAppOutbound(
      actionId,
      message,
      metadata,
      event.timestamp,
    );
    if (progressRow) {
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
      this.markProjectedTransportEvent(actionId, event.eventId, chatId);
      return projected;
    }

    if (metadata.kind !== "final_result") return false;
    const queuedFinalProjection = queuedFinalProjectionDisposition({
      butlerData: this.options.butlerData,
      metadata,
    });
    if (queuedFinalProjection === "defer") {
      this.deferredQueuedFinalOutbounds.set(actionId, { chatId, event });
      return false;
    }
    this.deferredQueuedFinalOutbounds.delete(actionId);
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
    });
  }

  private reconcileDeferredQueuedFinalOutbounds(chatId?: string): number {
    let projectedCount = 0;
    for (const [actionId, pending] of [
      ...this.deferredQueuedFinalOutbounds.entries(),
    ]) {
      if (chatId && pending.chatId !== chatId) continue;
      if (this.hasProjectedTransportEvent(actionId)) {
        this.deferredQueuedFinalOutbounds.delete(actionId);
        continue;
      }
      if (this.projectAppOutboundEvent(pending.chatId, pending.event)) {
        projectedCount += 1;
      }
      if (this.hasProjectedTransportEvent(actionId)) {
        this.deferredQueuedFinalOutbounds.delete(actionId);
      }
    }
    return projectedCount;
  }

  private projectAppDeliveryEvent(event: TranscriptEvent): boolean {
    const actionId = safeOptionalShortText(event.payload.actionId);
    if (!actionId) return false;
    const pending = this.pendingAppTurnEventOutbounds.get(actionId);
    if (!pending) return false;
    this.pendingAppTurnEventOutbounds.delete(actionId);
    if (event.payload.ok !== true) return false;
    if (this.hasProjectedTransportEvent(actionId)) return false;
    return this.projectAppOutboundEvent(
      pending.chatId,
      pending.event,
      "delivered",
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
