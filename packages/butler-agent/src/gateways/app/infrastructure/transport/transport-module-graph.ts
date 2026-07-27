import type { SessionBindingStore } from "../../../../test-support/harness/session-store.ts";
import type { ButlerServiceClient } from "../../../core/client.ts";
import type { AppMessageFileStore } from "../../domain/message-files/message-file-store.ts";
import { AppTransportProjectionStore } from "./transport-projection-store.ts";
import { AppTransportProjectionOwner } from "./transport-projection-owner.ts";
import { AppTransportReceiptMigrationOwner } from
  "./receipt-migration-owner.ts";
import { AppTransportHistoricalReconciliationOwner } from
  "./historical-reconciliation-owner.ts";
import { AppTransportQueueStore } from "./transport-queue-store.ts";
import { Database } from "bun:sqlite";
import { recordOperationalMetric } from
  "../../../../operations/metrics/operational-metrics.ts";
import { TerminalSettlementWakeStore } from
  "../retention/terminal-settlement-wake-store.ts";
import { TerminalSettlementWakeOwner } from
  "../retention/terminal-settlement-wake-owner.ts";

export interface AppTransportModuleGraph {
  appTransportQueue: AppTransportQueueStore;
  transportProjection: AppTransportProjectionStore;
  transportProjectionOwner: AppTransportProjectionOwner;
}

export function createAppTransportModuleGraph(input: {
  db: Database;
  butlerData: string;
  butlerHome: string;
  serviceClient: ButlerServiceClient;
  sessionBindingStore: SessionBindingStore;
  messageFiles: AppMessageFileStore;
  host: any;
}): AppTransportModuleGraph {
  const {
    db,
    butlerData,
    butlerHome,
    serviceClient,
    sessionBindingStore,
    messageFiles,
    host,
  } = input;
  const appTransportQueue = new AppTransportQueueStore(
    butlerData,
    butlerHome,
    serviceClient,
    sessionBindingStore,
    messageFiles,
    (chatId) => host.getChatRow(chatId),
    (projectId) => host.getProjectRow(projectId),
    () => host.getSettings(),
    (turnId) => host.getTurn(turnId),
    (type, payload) => {
      host.appendEvent(type, payload);
    },
    (chatId, turnId, event) => {
      host.appendTurnEvent(chatId, turnId, event);
    },
    (turnId, state, options) => host.updateTurnState(turnId, state, options),
    (turn) => {
      host.appendTerminalTurnStateChanged(turn);
    },
  );
  const transportProjection = new AppTransportProjectionStore({
    db,
    butlerData,
    butlerHome,
    messageFiles,
    getChatRow: (chatId) => host.getChatRow(chatId),
    getProjectRow: (projectId) => host.getProjectRow(projectId),
    getTurn: (turnId) => host.getTurn(turnId),
    getTurnRow: (turnId) => host.getTurnRow(turnId),
    getMessageRow: (messageId) => host.getMessageRow(messageId),
    getLatestAssistantMessageForTurn: (turnId) =>
      host.getLatestAssistantMessageForTurn(turnId),
    insertMessage: (chatId, role, text, status, options) =>
      host.insertMessage(chatId, role, text, status, options),
    insertOrReplaceAssistantReplies: (chatId, turnId, texts, files) =>
      host.insertOrReplaceAssistantReplies(chatId, turnId, texts, files),
    updateTurnState: (turnId, state, options) =>
      host.updateTurnState(turnId, state, options),
    appendTerminalTurnStateChanged: (turn) =>
      host.appendTerminalTurnStateChanged(turn),
    appendEvent: (type, payload) => {
      host.appendEvent(type, payload);
    },
    appendTurnEvent: (chatId, turnId, event) => {
      host.appendTurnEvent(chatId, turnId, event);
    },
    appendProgressSummaryEvent: (chatId, turnId, row) =>
      host.appendProgressSummaryEvent(chatId, turnId, row),
    hasTurnEventKind: (turnId, kind) => host.hasTurnEventKind(turnId, kind),
    hasEquivalentProgressSummaryRow: (turnId, row) =>
      host.hasEquivalentProgressSummaryRow(turnId, row),
    finalizeResponderLimitedDelivery: (chatId, turnId, delivery) =>
      host.finalizeResponderLimitedDelivery(chatId, turnId, delivery),
    upsertAssistantTurnFailure: (chatId, turnId, safeError, options) =>
      host.upsertAssistantTurnFailure(chatId, turnId, safeError, options),
    runtimeFaultRecordForTurn: (turnId) =>
      host.runtimeFaultRecordForTurn(turnId),
    generatedSessionTitleHandler: (chatId, sourceText) =>
      host.generatedSessionTitleHandler(chatId, sourceText),
    touchChat: (chatId) => host.touchChat(chatId),
    drainQueuedSessionMessages: (chatId) =>
      host.drainQueuedSessionMessages(chatId),
  });
  const recordProjectionFailure = (name: string, error: unknown) =>
    recordOperationalMetric({
      category: "runtime",
      name,
      status: "error",
      dimensions: {
        error_name: error instanceof Error ? error.name : "unknown",
      },
    }, { butlerData });
  const receiptMigrationOwner = new AppTransportReceiptMigrationOwner({
    migrateNextBatch: () =>
      transportProjection.migrateLegacyReceiptsNextBatch(),
    recordFailure: (error) =>
      recordProjectionFailure("app.transport_receipt_migration", error),
  });
  const historicalReconciliationOwner =
    new AppTransportHistoricalReconciliationOwner({
      reconcileNextPage: () =>
        transportProjection.reconcileNextHistoricalPage(),
      recordFailure: (error) =>
        recordProjectionFailure(
          "app.transport_historical_reconciliation",
          error,
        ),
    });
  const terminalSettlementWakes = new TerminalSettlementWakeStore(db);
  const terminalSettlementWakeOwner = new TerminalSettlementWakeOwner({
    consumeNextBatch: () =>
      terminalSettlementWakes.consumeNextBatch((turnId) =>
        host.scheduleTerminalTurnRetention(turnId),
      ),
    recordFailure: (error) =>
      recordProjectionFailure("app.terminal_settlement_wake", error),
  });
  const transportProjectionOwner = new AppTransportProjectionOwner({
    butlerData,
    syncNextBatch: () => transportProjection.syncNextBatch(),
    reopenCompletedLiveLanes: () =>
      transportProjection.reopenCompletedLiveLanes(),
    terminalSettlementWakeOwner,
    recordFailure: (error) =>
      recordProjectionFailure("app.transport_projection", error),
    maintenanceOwner: {
      start: () => {
        receiptMigrationOwner.start();
        historicalReconciliationOwner.start();
      },
      close: () => {
        historicalReconciliationOwner.close();
        receiptMigrationOwner.close();
      },
    },
  });
  return { appTransportQueue, transportProjection, transportProjectionOwner };
}
