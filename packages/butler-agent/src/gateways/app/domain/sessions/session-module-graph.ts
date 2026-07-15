import { Database } from "bun:sqlite";
import { cancelPersistedRuntimeTurn } from "../../../../agent/turn/principal-turn-cancellation.ts";
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
import {
  appResponderRuntimeRecoveryOwnsTurn,
  cancelAppResponderRuntimeTurn,
  routeAppResponderRuntimeInterruption,
} from "./app-responder-interruption-router.ts";

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
  const messageFiles = new AppMessageFileStore(db, butlerData, (sessionId) =>
    host.ensureChat(sessionId),
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
    db,
    listMessages: (sessionId) => host.listMessages(sessionId),
    getTurnRow: (turnId) => host.getTurnRow(turnId),
    listProgressRowsForTurn: (turnId) => host.listProgressRowsForTurn(turnId),
  });
  const turnProgressView = new AppTurnProgressViewStore({
    getTurnRow: (turnId) => host.getTurnRow(turnId),
    listProgressRowsForTurn: (turnId) => host.listProgressRowsForTurn(turnId),
    deliveryMetadataForTurnRecord: (turn) =>
      host.deliveryMetadataForTurnRecord(turn),
  });
  const limitedDelivery = new AppLimitedDeliveryStore({
    db,
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
    runtimeRecoveryOwnsTurn: (turnId) =>
      appResponderRuntimeRecoveryOwnsTurn(butlerData, turnId),
  });
  const userMessageTurns = new AppUserMessageTurnStore({
    butlerData,
    defaultChatId,
    ensureChat: (chatId) => host.ensureChat(chatId),
    sessionHasActiveTurn: (chatId) => host.sessionHasActiveTurn(chatId),
    createQueuedMessage: (queueInput) => host.createQueuedMessage(queueInput),
    listMessages: (chatId) => host.listMessages(chatId),
    validateAttachable: (chatId, attachments) =>
      messageFiles.validateAttachable(chatId, attachments ?? []),
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
    finalizeResponderLimitedDelivery: (chatId, turnId, delivery) =>
      host.finalizeResponderLimitedDelivery(chatId, turnId, delivery),
    markResponderNonPublicContinuation: (chatId, turnId, safeErrorCode) =>
      host.markResponderNonPublicContinuation(chatId, turnId, safeErrorCode),
    routeResponderRuntimeInterruption: (turnInput, error) => {
      const chat = host.getChatRow(turnInput.chatId);
      routeAppResponderRuntimeInterruption({
        butlerData,
        chatId: turnInput.chatId,
        turnId: turnInput.turnId,
        messageId: turnInput.messageId,
        text: turnInput.text,
        actor: "user",
        projectId: chat?.project_id ?? null,
        origin: "legacy_responder",
        boundary: "direct_responder_completion",
        error,
      });
    },
    finalizeCancelledTurn: (chatId, turnId) => {
      cancelPersistedRuntimeTurn({ butlerData, turnId });
      cancelAppResponderRuntimeTurn(butlerData, turnId);
      return host.finalizeCancelledTurn(chatId, turnId);
    },
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
