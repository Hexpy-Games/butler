import type { SessionBindingStore } from "../../../../test-support/harness/session-store.ts";
import type { ButlerServiceClient } from "../../../core/client.ts";
import type { AppMessageFileStore } from "../../domain/message-files/message-file-store.ts";
import { AppTransportProjectionStore } from "./transport-projection-store.ts";
import { AppTransportQueueStore } from "./transport-queue-store.ts";
import { Database } from "bun:sqlite";
import {
  appResponderRuntimeRecoveryOwnsTurn,
  routeAppResponderRuntimeInterruption,
} from "../../domain/sessions/app-responder-interruption-router.ts";

export interface AppTransportModuleGraph {
  appTransportQueue: AppTransportQueueStore;
  transportProjection: AppTransportProjectionStore;
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
    db,
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
    markResponderNonPublicContinuation: (chatId, turnId, safeErrorCode) =>
      host.markResponderNonPublicContinuation(chatId, turnId, safeErrorCode),
    routeResponderRuntimeInterruption: (turnInput) => {
      const turn = host.getTurnRow(turnInput.turnId);
      const userMessage = turn?.user_message_id
        ? host.getMessageRow(turn.user_message_id)
        : null;
      const chat = host.getChatRow(turnInput.chatId);
      routeAppResponderRuntimeInterruption({
        butlerData,
        chatId: turnInput.chatId,
        turnId: turnInput.turnId,
        messageId: userMessage?.id ?? turnInput.turnId,
        text: userMessage?.text ?? "",
        actor: "user",
        projectId: chat?.project_id ?? null,
        origin: "projection",
        boundary: "transport_failure_projection",
        error: {
          message: turnInput.message,
          metadata: turnInput.metadata,
        },
        now: turnInput.eventTimestamp,
      });
    },
    runtimeRecoveryOwnsTurn: (turnId) =>
      appResponderRuntimeRecoveryOwnsTurn(butlerData, turnId),
    generatedSessionTitleHandler: (chatId, sourceText) =>
      host.generatedSessionTitleHandler(chatId, sourceText),
    touchChat: (chatId) => host.touchChat(chatId),
    drainQueuedSessionMessages: (chatId) =>
      host.drainQueuedSessionMessages(chatId),
  });
  return { appTransportQueue, transportProjection };
}
