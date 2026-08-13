import { Database } from "bun:sqlite";
import type { AppMessageFileStore } from "../message-files/message-file-store.ts";
import { AppContextDetailsStore } from "./context-details-store.ts";
import { AppGeneratedSessionTitleStore } from "./generated-session-title-store.ts";
import { AppResponderRuntime } from "./responder-runtime.ts";
import { AppSessionQueueDispatcher } from "./session-queue-dispatcher.ts";
import { AppSessionQueueStore } from "./session-queue-store.ts";
import { AppSessionViewStore } from "./session-view-store.ts";
import { AppSystemResponderTurnStore } from "./system-responder-turn-store.ts";
import { AppTurnActionStore } from "./turn-action-store.ts";
import type { ButlerServiceClient } from "../../../core/client.ts";

export interface AppSessionInteractionModuleGraph {
  generatedSessionTitles: AppGeneratedSessionTitleStore;
  responderRuntime: AppResponderRuntime;
  systemResponderTurns: AppSystemResponderTurnStore;
  turnActions: AppTurnActionStore;
  contextDetails: AppContextDetailsStore;
  sessionViews: AppSessionViewStore;
  sessionQueue: AppSessionQueueStore;
  sessionQueueDispatcher: AppSessionQueueDispatcher;
}

export function createAppSessionInteractionModuleGraph(input: {
  db: Database;
  butlerData: string;
  defaultChatTitle: string;
  messageFiles: AppMessageFileStore;
  serviceClient: ButlerServiceClient;
  host: any;
}): AppSessionInteractionModuleGraph {
  const { db, butlerData, defaultChatTitle, messageFiles, serviceClient, host } = input;
  const generatedSessionTitles = new AppGeneratedSessionTitleStore({
    db,
    defaultChatTitle,
    getChatRow: (chatId) => host.getChatRow(chatId),
    updateSession: (sessionId, update) => host.updateSession(sessionId, update),
  });
  const responderRuntime = new AppResponderRuntime({
    messageFiles,
    getChatRow: (chatId) => host.getChatRow(chatId),
    getProjectRow: (projectId) => host.getProjectRow(projectId),
    getSettings: () => host.getSettings(),
    generatedSessionTitleHandler: (chatId, sourceText) =>
      host.generatedSessionTitleHandler(chatId, sourceText),
  });
  const systemResponderTurns = createSystemResponderTurns({
    butlerData,
    messageFiles,
    host,
  });
  const turnActions = new AppTurnActionStore({
    db,
    serviceClient,
    getTurn: (turnId) => host.getTurn(turnId),
    getTurnRow: (turnId) => host.getTurnRow(turnId),
    runtimeFaultRecordForTurn: (turnId) =>
      host.runtimeFaultRecordForTurn(turnId),
    getMessageRow: (messageId) => host.getMessageRow(messageId),
    refsForMessage: (messageId) => messageFiles.refsForMessage(messageId),
    claimRetryTurn: (turnId, attempt) => host.claimRetryTurn(turnId, attempt),
    appendEvent: (type, payload) => {
      host.appendEvent(type, payload);
    },
    deleteAssistantMessagesForTurn: (turnId) =>
      host.deleteAssistantMessagesForTurn(turnId),
    enqueueAppTransportTurn: (turnInput) =>
      host.enqueueAppTransportTurn(turnInput),
    sendMessageWithCurrentControls: (request, responder, options) =>
      host.sendMessage(request, responder, options),
    dispatchDeferredResponderTurn: (turnInput) =>
      host.dispatchDeferredResponderTurn(turnInput),
    completeResponderTurn: (turnInput) => host.completeResponderTurn(turnInput),
    finalizeCancelledTurn: (chatId, turnId) =>
      host.finalizeCancelledTurn(chatId, turnId),
    cleanupTurnEventSequences: (chatId, turnId) =>
      host.cleanupTurnEventSequences(chatId, turnId),
    ensureCancelledTurnActivityMessage: (chatId, turnId) =>
      host.ensureCancelledTurnActivityMessage(chatId, turnId),
  });
  const contextDetails = new AppContextDetailsStore(
    butlerData,
    messageFiles,
    (sessionId) => host.ensureChat(sessionId),
    (sessionId) => host.getSessionControls(sessionId),
    () => host.registeredModelMetadata(),
    () => host.getSettings(),
    () => host.getPersonalization(),
    (sessionId) => host.sessionViewMessages(sessionId),
    (sessionId) => host.latestTurn(sessionId),
    (sessionId) => host.countTurns(sessionId),
    (sessionId) => host.getProjectForSession(sessionId),
    (sessionId) => host.getChatRow(sessionId)?.kind ?? "chat",
    (sessionId) => host.listArtifacts(sessionId),
  );
  const sessionViews = new AppSessionViewStore(
    (sessionId) => host.getSession(sessionId),
    (sessionId) => host.latestTurn(sessionId),
    (sessionId) => host.listMessages(sessionId),
    (sessionId) => host.sessionViewMessages(sessionId),
    (turn, options) => host.sessionViewTurn(turn, options),
    (sessionId) => host.branchInfoForSession(sessionId),
    (sessionId, turnId) => host.loadedSkillNamesForSession(sessionId, turnId),
    (sessionId) => host.getContextDetails(sessionId),
    (sessionId) => host.listAutomationTargets(sessionId),
    (options) => host.listWorkerActivity(options),
    (sessionId, runtimeSessionId, currentTurnId) =>
      host.listActiveWorkStreams(sessionId, runtimeSessionId, currentTurnId),
    () => host.latestEventCursor(),
    (sessionId) => host.ensureChat(sessionId),
  );
  const sessionQueue = new AppSessionQueueStore(
    db,
    messageFiles,
    (sessionId) => host.ensureChat(sessionId),
    (sessionId, request) => host.controlsForMessageSend(sessionId, request),
    async (files, model) => await messageFiles.admitVisualAttachments(
      files,
      model,
      host.registeredModelMetadata(),
    ),
    (sessionId) => host.getSessionControls(sessionId),
    () => host.registeredModelMetadata(),
    (type, payload) => {
      host.appendEvent(type, payload);
    },
  );
  const sessionQueueDispatcher = new AppSessionQueueDispatcher({
    db,
    messageFiles,
    sessionHasActiveTurn: (sessionId) => host.sessionHasActiveTurn(sessionId),
    queuedControlsFromRow: (row) => host.queuedControlsFromRow(row),
    sendMessage: (request, responder, options, visualAdmission) =>
      host.userMessageTurns.sendMessage(request, responder, options, visualAdmission),
    validateVisualAdmission: (admission, model) =>
      messageFiles.validateVisualAdmission(
        admission,
        model,
        host.registeredModelMetadata(),
      ),
    appendEvent: (type, payload) => {
      host.appendEvent(type, payload);
    },
  });
  return {
    generatedSessionTitles,
    responderRuntime,
    systemResponderTurns,
    turnActions,
    contextDetails,
    sessionViews,
    sessionQueue,
    sessionQueueDispatcher,
  };
}

function createSystemResponderTurns(input: {
  butlerData: string;
  messageFiles: AppMessageFileStore;
  host: any;
}): AppSystemResponderTurnStore {
  const { messageFiles, host } = input;
  return new AppSystemResponderTurnStore({
    ensureChat: (chatId) => host.ensureChat(chatId),
    getSessionControls: (chatId) => host.getSessionControls(chatId),
    insertTurn: (chatId, state, safeStatusLabel) =>
      host.insertTurn(chatId, state, safeStatusLabel),
    appendTurnAcknowledgedEvent: (chatId, turnId) =>
      host.appendTurnAcknowledgedEvent(chatId, turnId),
    updateTurnState: (turnId, state, options) =>
      host.updateTurnState(turnId, state, options),
    appendEvent: (type, payload) => {
      host.appendEvent(type, payload);
    },
    appendTurnEvent: (chatId, turnId, event) => {
      host.appendTurnEvent(chatId, turnId, event);
    },
    appendProgressSummaryEvent: (chatId, turnId, row) =>
      host.appendProgressSummaryEvent(chatId, turnId, row),
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
    hasTurnEventKind: (turnId, kind) => host.hasTurnEventKind(turnId, kind),
    appendTerminalTurnStateChanged: (turn) =>
      host.appendTerminalTurnStateChanged(turn),
    touchChat: (chatId) => host.touchChat(chatId),
    createResponderFiles: (chatId, files) =>
      messageFiles.createResponderFiles(chatId, files ?? []),
    insertOrReplaceAssistantReplies: (chatId, turnId, texts, files) =>
      host.insertOrReplaceAssistantReplies(chatId, turnId, texts, files),
    finalizeCancelledTurn: (chatId, turnId) =>
      host.finalizeCancelledTurn(chatId, turnId),
    getMessageRow: (messageId) => host.getMessageRow(messageId),
    refsForMessage: (messageId) => messageFiles.refsForMessage(messageId),
    upsertAssistantTurnFailure: (chatId, turnId, safeError, options) =>
      host.upsertAssistantTurnFailure(chatId, turnId, safeError, options),
    runtimeFaultRecordForTurn: (turnId) =>
      host.runtimeFaultRecordForTurn(turnId),
    cleanupTurnEventSequences: (chatId, turnId) =>
      host.cleanupTurnEventSequences(chatId, turnId),
  });
}
