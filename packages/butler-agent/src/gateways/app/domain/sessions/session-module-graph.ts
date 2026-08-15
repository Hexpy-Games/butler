import { Database } from "bun:sqlite";
import { AppMessageFileStore } from "../message-files/message-file-store.ts";
import { AppSessionRecordStore } from "./session-record-store.ts";
import { AppAssistantMessageStore } from "./assistant-message-store.ts";
import { AppSessionMessageProjectionStore } from "./session-message-projection-store.ts";
import { AppTurnProgressViewStore } from "./turn-progress-view-store.ts";
import { AppLimitedDeliveryStore } from "./limited-delivery-store.ts";
import { AppUserMessageTurnStore } from "./user-message-turn-store.ts";
import { AppResponderRuntime } from "./responder-runtime.ts";
import {
  createAppSessionInteractionModuleGraph,
  type AppSessionInteractionModuleGraph,
} from "./session-interaction-module-graph.ts";
import { resolveProviderVisualCapability } from "../../../../integrations/providers/registry.ts";
import type { SessionMessagePageOptions } from "./session-message-page.ts";

export interface AppSessionModuleGraph {
  messageFiles: AppMessageFileStore;
  sessionRecords: AppSessionRecordStore;
  assistantMessages: AppAssistantMessageStore;
  sessionMessageProjection: AppSessionMessageProjectionStore;
  turnProgressView: AppTurnProgressViewStore;
  limitedDelivery: AppLimitedDeliveryStore;
  userMessageTurns: AppUserMessageTurnStore;
  generatedSessionTitles: AppSessionInteractionModuleGraph["generatedSessionTitles"];
  responderRuntime: AppResponderRuntime;
  systemResponderTurns: AppSessionInteractionModuleGraph["systemResponderTurns"];
  turnActions: AppSessionInteractionModuleGraph["turnActions"];
  contextDetails: AppSessionInteractionModuleGraph["contextDetails"];
  sessionViews: AppSessionInteractionModuleGraph["sessionViews"];
  sessionQueue: AppSessionInteractionModuleGraph["sessionQueue"];
  sessionQueueDispatcher: AppSessionInteractionModuleGraph["sessionQueueDispatcher"];
}

export function createAppSessionModuleGraph(input: {
  db: Database;
  butlerData: string;
  butlerHome: string;
  defaultChatId: string;
  defaultChatTitle: string;
  host: any;
}): AppSessionModuleGraph {
  const { db, butlerData, defaultChatId, defaultChatTitle, host } = input;
  const messageFiles = new AppMessageFileStore(
    db,
    butlerData,
    (sessionId) => host.ensureChat(sessionId),
    { resolve: resolveProviderVisualCapability },
  );
  const sessionRecords = new AppSessionRecordStore(
    db,
    butlerData,
    messageFiles,
    (projectId) => host.getProjectRow(projectId),
    (type, payload) => {
      host.appendEvent(type, payload);
    },
  );
  const assistantMessages = new AppAssistantMessageStore({
    db,
    messageFiles,
    insertMessage: (chatId, role, text, status, options) =>
      host.insertMessage(chatId, role, text, status, options),
    updateMessage: (messageId, update) => host.updateMessage(messageId, update),
    messageRecordById: (messageId) => host.messageRecordById(messageId),
    getLatestAssistantMessageForTurn: (turnId) =>
      host.getLatestAssistantMessageForTurn(turnId),
    listMessages: (chatId) => host.listMessages(chatId),
    messageWithTerminalWorkBlocks: (message, turnId) =>
      host.messageWithTerminalWorkBlocks(message, turnId),
    appendEvent: (type, payload) => {
      host.appendEvent(type, payload);
    },
  });
  const sessionMessageProjection = new AppSessionMessageProjectionStore({
    listMessages: (sessionId, options?: SessionMessagePageOptions) =>
      host.listMessages(sessionId, options),
    listMessagePage: (sessionId, options?: SessionMessagePageOptions) =>
      host.listMessagePage(sessionId, options),
    getTurnRow: (turnId) => host.getTurnRow(turnId),
    listProgressRowsForTurn: (turnId) => host.listProgressRowsForTurn(turnId),
    explicitDeliveryMetadataForTurn: (turnId) =>
      host.explicitDeliveryMetadataForTurn(turnId),
  });
  const turnProgressView = new AppTurnProgressViewStore({
    getTurnRow: (turnId) => host.getTurnRow(turnId),
    listProgressRowsForTurn: (turnId) => host.listProgressRowsForTurn(turnId),
    deliveryMetadataForTurnRecord: (turn) =>
      host.deliveryMetadataForTurnRecord(turn),
  });
  const limitedDelivery = new AppLimitedDeliveryStore({
    hasPublicContinuationProgressSinceLatestQueue: (turnId) =>
      host.hasPublicContinuationProgressSinceLatestQueue(turnId),
    hasTurnEventKind: (turnId, kind) => host.hasTurnEventKind(turnId, kind),
    appendTurnEvent: (chatId, turnId, event) => {
      host.appendTurnEvent(chatId, turnId, event);
    },
    deleteAssistantMessagesForTurn: (turnId) =>
      host.deleteAssistantMessagesForTurn(turnId),
    insertOrReplaceAssistantReplies: (chatId, turnId, texts, files) =>
      host.insertOrReplaceAssistantReplies(chatId, turnId, texts, files),
    updateTurnState: (turnId, state, options) =>
      host.updateTurnState(turnId, state, options),
    appendTerminalTurnStateChanged: (turn) =>
      host.appendTerminalTurnStateChanged(turn),
    appendEvent: (type, payload) => {
      host.appendEvent(type, payload);
    },
    getTurnRow: (turnId) => host.getTurnRow(turnId),
    getMessageRow: (messageId) => host.getMessageRow(messageId),
    refsForMessage: (messageId) => messageFiles.refsForMessage(messageId),
    enqueueAppTransportTurn: (turnInput) =>
      host.enqueueAppTransportTurn(turnInput),
  });
  const userMessageTurns = new AppUserMessageTurnStore({
    butlerData,
    defaultChatId,
    ensureChat: (chatId) => host.ensureChat(chatId),
    sessionHasActiveTurn: (chatId) => host.sessionHasActiveTurn(chatId),
    createQueuedMessage: (queueInput, visualAdmission) =>
      host.sessionQueue.createQueuedMessage(queueInput, visualAdmission),
    listMessages: (chatId) => host.listMessages(chatId),
    validateAttachable: (chatId, attachments) =>
      messageFiles.validateAttachable(chatId, attachments ?? []),
    admitVisualAttachments: async (files, model) =>
      await messageFiles.admitVisualAttachments(
        files,
        model,
        host.registeredModelMetadata(),
      ),
    resolveControlsForMessageSend: (chatId, request) =>
      host.resolveControlsForMessageSend(chatId, request),
    insertTurn: (chatId, state, safeStatusLabel, controlResolution) =>
      host.insertTurn(chatId, state, safeStatusLabel, controlResolution),
    insertMessage: (chatId, role, text, status, options) =>
      host.insertMessage(chatId, role, text, status, options),
    setTurnUserMessage: (turnId, messageId) =>
      host.setTurnUserMessage(turnId, messageId),
    appendEvent: (type, payload) => {
      host.appendEvent(type, payload);
    },
    appendTurnAcknowledgedEvent: (chatId, turnId) =>
      host.appendTurnAcknowledgedEvent(chatId, turnId),
    updateTurnState: (turnId, state, options) =>
      host.updateTurnState(turnId, state, options),
    enqueueAppTransportTurn: (turnInput) =>
      host.enqueueAppTransportTurn(turnInput),
    appendProgressSummaryEvent: (chatId, turnId, row) =>
      host.appendProgressSummaryEvent(chatId, turnId, row),
    appendTurnEvent: (chatId, turnId, event) => {
      host.appendTurnEvent(chatId, turnId, event);
    },
    cleanupTurnEventSequences: (chatId, turnId) =>
      host.cleanupTurnEventSequences(chatId, turnId),
    createResponderMessageFiles: (chatId, files) =>
      messageFiles.createResponderFiles(chatId, files ?? []),
    drainQueuedSessionMessages: (chatId, responder, options) =>
      host.drainQueuedSessionMessages(chatId, responder, options),
    finalizeCancelledTurn: (chatId, turnId) =>
      host.finalizeCancelledTurn(chatId, turnId),
    hasTurnEventKind: (turnId, kind) => host.hasTurnEventKind(turnId, kind),
    insertOrReplaceAssistantReplies: (chatId, turnId, texts, files) =>
      host.insertOrReplaceAssistantReplies(chatId, turnId, texts, files),
    runResponder: (
      chatId,
      turnId,
      messageId,
      text,
      responder,
      options,
      onProgress,
      onTurnEvent,
    ) =>
      host.runResponder(
        chatId,
        turnId,
        messageId,
        text,
        responder,
        options,
        onProgress,
        onTurnEvent,
      ),
    touchChat: (chatId) => host.touchChat(chatId),
    appendTerminalTurnStateChanged: (turn) =>
      host.appendTerminalTurnStateChanged(turn),
    runtimeFaultRecordForTurn: (turnId) =>
      host.runtimeFaultRecordForTurn(turnId),
    upsertAssistantTurnFailure: (chatId, turnId, safeError, options) =>
      host.upsertAssistantTurnFailure(chatId, turnId, safeError, options),
  });
  const interactionModules = createAppSessionInteractionModuleGraph({
    db,
    butlerData,
    defaultChatTitle,
    messageFiles,
    host,
  });
  return {
    messageFiles,
    sessionRecords,
    assistantMessages,
    sessionMessageProjection,
    turnProgressView,
    limitedDelivery,
    userMessageTurns,
    ...interactionModules,
  };
}
