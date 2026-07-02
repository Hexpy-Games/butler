import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { AppAutomationStore } from "../../domain/automations/automation-store.ts";
import { migrateAppStoreSchema, seedAppStoreDefaults } from "../../infrastructure/core/schema.ts";
import { AppEventStore } from "../../infrastructure/events/event-store.ts";
import { AppTurnProgressEventStore } from "../../infrastructure/events/turn-progress-event-store.ts";
import { AppIntegrationStore } from "../../domain/integrations/integration-store.ts";
import { AppModelRegistryStore } from "../../domain/integrations/model-registry-store.ts";
import { AppModelSettingsPolicy } from "../../domain/integrations/model-settings-policy.ts";
import {
  DEFAULT_APP_UPDATE_MANIFEST,
  DEFAULT_CHAT_ID,
  DEFAULT_CHAT_TITLE,
  type AppServerStoreOptions,
} from "./app-store-options.ts";
import { AppProjectDashboardStore } from "../../domain/projects/project-dashboard-store.ts";
import { AppProjectFolderStore } from "../../domain/projects/project-folder-store.ts";
import { AppProjectStore } from "../../domain/projects/project-store.ts";
import { AppRuntimeInfoStore } from "../../domain/runtime/runtime-info-store.ts";
import { AppSystemMonitorStore } from "../../domain/runtime/system-monitor-store.ts";
import { AppNavigationStore } from "../../domain/sessions/navigation-store.ts";
import { AppNewChatBriefingStore } from "../../domain/sessions/new-chat-briefing-store.ts";
import { AppConversationProjectionStore } from "../../domain/projections/app-conversation-projection-store.ts";
import { AppSessionCatalogStore } from "../../domain/sessions/session-catalog-store.ts";
import { AppSessionControlsStore } from "../../domain/sessions/session-controls-store.ts";
import { createAppSessionModuleGraph } from "../../domain/sessions/session-module-graph.ts";
import { AppTurnRecordStore } from "../../domain/sessions/turn-record-store.ts";
import { AppPersonalizationStore } from "../../domain/settings/personalization-store.ts";
import { AppPreferencesStore } from "../../domain/settings/preferences-store.ts";
import { AppSettingsPersistence } from "../../domain/settings/settings-persistence.ts";
import { createAppTransportModuleGraph } from "../../infrastructure/transport/transport-module-graph.ts";
import { AppWorkerActivityStore } from "../../domain/workers/worker-activity-store.ts";
import { AppWorkerControlStore } from "../../domain/workers/worker-control-store.ts";
import { FileQueueButlerServiceClient } from "../../../core/client.ts";
import { SessionBindingStore } from "../../../../test-support/harness/session-store.ts";
import type { AppStoreKernel } from "./app-store-kernel.ts";

export function initializeAppStoreKernel(
  kernel: AppStoreKernel,
  options: AppServerStoreOptions = {},
): void {
  kernel.closed = false;
  kernel.projectWorkspaceRoot = resolve(
    options.projectWorkspaceRoot ?? join(homedir(), "butler-workspace"),
  );
  kernel.folderSelectionSecret = options.folderSelectionSecret;
  kernel.butlerData = resolve(
    options.butlerData ??
      process.env.BUTLER_DATA ??
      join(homedir(), ".butler"),
  );
  kernel.butlerHome = resolve(
    options.butlerHome ?? process.env.BUTLER_HOME ?? process.cwd(),
  );
  kernel.appVersion = safeString(options.appVersion);
  kernel.appUpdateManifest =
    safeString(options.appUpdateManifest) ??
    safeString(process.env.BUTLER_APP_UPDATE_MANIFEST) ??
    safeString(process.env.BUTLER_UPDATE_MANIFEST) ??
    DEFAULT_APP_UPDATE_MANIFEST;
  kernel.serverUrl = options.serverUrl ?? "http://127.0.0.1:18765";
  kernel.bridgeMode = options.bridgeMode ?? "local";
  kernel.serviceClient =
    options.serviceClient ??
    new FileQueueButlerServiceClient({ butlerData: kernel.butlerData });
  kernel.sessionBindingStore = new SessionBindingStore(
    join(kernel.butlerData, "runtime", "session-store.sqlite"),
  );
  kernel.runtimeInfo = new AppRuntimeInfoStore(
    kernel.butlerHome,
    kernel.butlerData,
    kernel.appVersion,
    kernel.appUpdateManifest,
  );
  kernel.systemMonitor = new AppSystemMonitorStore(kernel.butlerData);
  kernel.db = new Database(options.dbPath ?? ":memory:", { create: true });
  kernel.db.run("PRAGMA journal_mode = WAL");
  kernel.db.run("PRAGMA foreign_keys = ON");
  kernel.events = new AppEventStore(kernel.db);
  kernel.turns = new AppTurnRecordStore(kernel.db, (turnId, kind) =>
    kernel.hasTurnEventKind(turnId, kind),
  );
  kernel.turnProgress = new AppTurnProgressEventStore({
    db: kernel.db,
    appendEvent: (type, payload) => kernel.appendEvent(type, payload),
    nextSessionTurnEventSequence: (sessionId) =>
      kernel.nextSessionTurnEventSequence(sessionId),
    nextTurnEventSequence: (turnId) => kernel.nextTurnEventSequence(turnId),
    shouldPersistRuntimeTurnEvent: (turnId, kind) =>
      kernel.shouldPersistRuntimeTurnEvent(turnId, kind),
    isTerminalTurn: (turnId) => kernel.isTerminalTurn(turnId),
    getTurnRow: (turnId) => kernel.getTurnRow(turnId),
  });
  kernel.settingsPersistence = new AppSettingsPersistence(kernel.db);
  kernel.modelSettingsPolicy = new AppModelSettingsPolicy(
    kernel.db,
    kernel.settingsPersistence,
    () => kernel.preferences.getSettings(),
    () => kernel.registeredModelMetadata(),
  );
  kernel.modelRegistry = new AppModelRegistryStore(
    kernel.butlerData,
    kernel.modelSettingsPolicy,
    (type, payload) => {
      kernel.appendEvent(type, payload);
    },
  );
  kernel.projectFolders = new AppProjectFolderStore(
    () => kernel.projectWorkspaceRoot,
  );
  kernel.projects = new AppProjectStore(
    kernel.db,
    kernel.projectFolders,
    kernel.folderSelectionSecret,
    () => kernel.sessionCatalog.listProjectSessions().sessions,
    (type, payload) => {
      kernel.appendEvent(type, payload);
    },
  );
  kernel.sessionCatalog = new AppSessionCatalogStore(kernel.db);
  kernel.navigation = new AppNavigationStore(
    () => kernel.automationStore.list(),
    () => kernel.preferences.getSettings(),
    () => kernel.sessionCatalog.listSessions(),
    () => kernel.sessionCatalog.listSessions({ kind: "chat" }),
    () => kernel.projects.listProjects(),
    () => kernel.projects.listProjects({ includeSessions: true }),
  );
  kernel.workers = new AppWorkerActivityStore(
    kernel.butlerData,
    (runtimeSessionId) => kernel.chatIdForRuntimeSession(runtimeSessionId),
  );
  kernel.workerControls = new AppWorkerControlStore(
    kernel.butlerData,
    (workerId) => kernel.workers.getWorkerActivity(workerId),
    (sessionId, role, text, status) =>
      kernel.insertMessage(sessionId, role, text, status),
    (type, payload) => {
      kernel.appendEvent(type, payload);
    },
  );
  kernel.preferences = new AppPreferencesStore(
    kernel.butlerData,
    kernel.serverUrl,
    kernel.bridgeMode,
    kernel.folderSelectionSecret,
    kernel.settingsPersistence,
    kernel.modelRegistry,
    () => kernel.projectWorkspaceRoot,
    (workspaceRoot) => {
      kernel.projectWorkspaceRoot = workspaceRoot;
    },
    (folderPath) => kernel.projectFolders.validateProjectFolder(folderPath),
    (type, payload) => {
      kernel.appendEvent(type, payload);
    },
  );
  kernel.personalization = new AppPersonalizationStore(
    kernel.butlerData,
    kernel.butlerHome,
    () => kernel.preferences.getSettings(),
    (type, payload) => {
      kernel.appendEvent(type, payload);
    },
  );
  kernel.sessionControls = new AppSessionControlsStore(
    kernel.settingsPersistence,
    () => kernel.preferences.getSettings(),
    () => kernel.registeredModelMetadata(),
    (sessionId) => kernel.ensureChat(sessionId),
    (type, payload) => {
      kernel.appendEvent(type, payload);
    },
  );
  const sessionModules = createAppSessionModuleGraph({
    db: kernel.db,
    butlerData: kernel.butlerData,
    butlerHome: kernel.butlerHome,
    defaultChatId: DEFAULT_CHAT_ID,
    defaultChatTitle: DEFAULT_CHAT_TITLE,
    host: kernel,
  });
  kernel.messageFiles = sessionModules.messageFiles;
  kernel.sessionRecords = sessionModules.sessionRecords;
  kernel.assistantMessages = sessionModules.assistantMessages;
  kernel.sessionMessageProjection = sessionModules.sessionMessageProjection;
  kernel.turnProgressView = sessionModules.turnProgressView;
  kernel.limitedDelivery = sessionModules.limitedDelivery;
  kernel.userMessageTurns = sessionModules.userMessageTurns;
  kernel.generatedSessionTitles = sessionModules.generatedSessionTitles;
  kernel.responderRuntime = sessionModules.responderRuntime;
  kernel.systemResponderTurns = sessionModules.systemResponderTurns;
  kernel.turnActions = sessionModules.turnActions;
  kernel.contextDetails = sessionModules.contextDetails;
  kernel.sessionViews = sessionModules.sessionViews;
  kernel.sessionQueue = sessionModules.sessionQueue;
  kernel.sessionQueueDispatcher = sessionModules.sessionQueueDispatcher;
  kernel.newChatBriefing = new AppNewChatBriefingStore({
    butlerData: kernel.butlerData,
    getSettings: () => kernel.preferences.getSettings(),
    getProjectRow: (projectId) => kernel.getProjectRow(projectId),
  });
  kernel.projectDashboard = new AppProjectDashboardStore(
    kernel.db,
    kernel.butlerData,
    (projectId) => kernel.getProjectRow(projectId),
    (projectId) =>
      kernel.sessionCatalog.listSessions({ kind: "project", projectId })
        .sessions,
  );
  const transportModules = createAppTransportModuleGraph({
    db: kernel.db,
    butlerData: kernel.butlerData,
    butlerHome: kernel.butlerHome,
    serviceClient: kernel.serviceClient,
    sessionBindingStore: kernel.sessionBindingStore,
    messageFiles: kernel.messageFiles,
    host: kernel,
  });
  kernel.appTransportQueue = transportModules.appTransportQueue;
  kernel.transportProjection = transportModules.transportProjection;
  kernel.integrations = new AppIntegrationStore(
    kernel.butlerData,
    kernel.butlerHome,
    () => kernel.projects.listProjects().projects,
  );
  kernel.automationStore = new AppAutomationStore({
    db: kernel.db,
    sessionLabel: (sessionId) => kernel.safeSessionLabel(sessionId),
    targetSession: (sessionId) => kernel.sessionRecords.getSession(sessionId),
    appendEvent: (type, payload) => {
      kernel.appendEvent(type, payload);
    },
    dispatchContext: {
      ensureSession: (sessionId) => kernel.sessionRecords.getSession(sessionId),
      sessionHasActiveTurn: (sessionId) =>
        kernel.sessionHasActiveTurn(sessionId),
      sendMessage: (input, responder, options) =>
        kernel.userMessageTurns.sendMessage(input, responder, options),
      createQueuedPromptMessage: (sessionId) =>
        kernel.insertMessage(
          sessionId,
          "automation",
          "Automation prompt queued.",
          "pending",
        ),
      markQueuedPromptDispatched: (messageId) => {
        const updated = kernel.updateMessage(messageId, {
          text: "Automation prompt dispatched.",
          status: "delivered",
        });
        kernel.appendEvent("message.updated", { message: updated });
        return updated;
      },
      markQueuedPromptFailed: (messageId, safeErrorCode) => {
        const updated = kernel.updateMessage(messageId, {
          text: "Automation prompt could not be dispatched.",
          status: "failed",
          safeErrorCode,
          retryable: true,
        });
        kernel.appendEvent("message.updated", { message: updated });
        return updated;
      },
      appendEvent: (type, payload) => {
        kernel.appendEvent(type, payload);
      },
    },
  });
  migrateAppStoreSchema(kernel.db);
  kernel.conversationProjection = new AppConversationProjectionStore({
    db: kernel.db,
    conversationReader: options.conversationProjectionReader,
  });
  kernel.projectWorkspaceRoot =
    kernel.settingsPersistence.readStoredProjectWorkspaceRoot() ??
    kernel.projectWorkspaceRoot;
  seedAppStoreDefaults(kernel.db);
  kernel.reconcileCancelledTurnActivityMessages();
}

function safeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
