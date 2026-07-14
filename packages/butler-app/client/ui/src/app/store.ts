import { create } from "zustand";
import {
  currentAdaptiveMode,
  normalizeAdaptivePanelState,
  restoreAdaptivePanelState,
} from "../libs/design-system/responsive.ts";
import {
  api,
  canSelectProjectFolder,
  isProjectFolderPickerUnavailable,
  selectProjectFolder,
} from "./api.ts";
import { appCopy, setAppCopyLanguage } from "./copy.ts";
import {
  ACTIVE_TURN_STATES,
  EMPTY_MODEL_CATALOG,
  EMPTY_NAVIGATION,
} from "./constants.ts";
import { notifyError } from "./notifications.ts";
import {
  messageListCursor,
  messageListSyncCursor,
  readCachedMessageListSync,
  readCachedMessageList,
  writeCachedMessageList,
} from "./messageCache.ts";
import {
  readCachedSettings,
  settingsWithDefaults,
  writeCachedSettings,
} from "./settingsCache.ts";
import { browserRandomId } from "./id.ts";
import {
  type OptimisticSessionStart,
  findSessionSummary,
  messagesWithChatId,
  navigationReplacingOptimisticSession,
  navigationWithSessionSummary,
  navigationWithOptimisticSession,
  navigationWithoutOptimisticSession,
  optimisticSessionId,
  summaryWithSessionId,
} from "./optimisticSession.ts";
import type { AppUiStateSnapshot } from "./appUiStateCache.ts";
import {
  DEFAULT_LEFT_PANEL_WIDTH,
  DEFAULT_RIGHT_PANEL_WIDTH,
} from "./panelSizing.ts";
import type {
  AppView,
  CommandPaletteResult,
  ComposerControls,
  MessageListView,
  MessageRecord,
  ModelCatalogView,
  ModelCatalogState,
  NavigationView,
  ProjectDashboardDocument,
  ProjectSummary,
  QueuedMessageRecord,
  SessionArtifactSummary,
  SessionQueueView,
  SessionSummary,
  SessionSummaryView,
  SessionView,
  SettingsSectionId,
  SettingsView,
  StatusPill,
  TimelineEvent,
  TurnProgressSnapshot,
  Updater,
} from "./types.ts";
import {
  activeChatFromNavigation,
  activeTitleForView,
  applyTimelineEventsToViewState,
  clientTurnIdFromMessageId,
  isWorkerVisibleInComposer,
  isDraftChatId,
  freezeMessageWorkBlocks,
  freezeMessageWorkBlocksForRecord,
  mergeSessionSummaryForPendingTurn,
  mergeTurnProgressFromSummary,
  mergeTurnProgressSnapshotMap,
  mergeMessages,
  normalizeSettingsSectionId,
  parseDraftChatId,
  pruneReplacedClientTurnProgress,
  projectDraftId,
  titleFromPrompt,
  runtimeModels,
} from "./utils.ts";
import { isServerBackedSessionId } from "./sessionIds.ts";

type ProjectAction = "rename" | "pin" | "archive" | "delete";
type SessionAction = "rename" | "archive";

interface ButlerStore {
  leftOpen: boolean;
  rightOpen: boolean;
  rightTab: string;
  selectedArtifactId: string | null;
  selectedArtifact: SessionArtifactSummary | null;
  leftPanelWidth: number;
  rightPanelWidth: number;
  sidebarChatsCollapsed: boolean;
  sidebarProjectsCollapsed: boolean;
  sidebarCollapsedProjectIds: string[];
  view: AppView;
  settingsReturnView: AppView;
  activeChatId: string;
  navigation: NavigationView;
  messages: MessageRecord[];
  sessionView: SessionView | null;
  messageLoadPending: boolean;
  optimisticSessionStart: OptimisticSessionStart | null;
  pendingProjectDocumentAttachment: {
    projectId: string;
    document: ProjectDashboardDocument;
  } | null;
  sessionMessageViews: Record<string, MessageListView>;
  summary: SessionSummaryView | null;
  turnProgress: Record<string, TurnProgressSnapshot>;
  sessionQueue: QueuedMessageRecord[];
  settings: SettingsView;
  modelCatalog: ModelCatalogView;
  modelCatalogState: ModelCatalogState;
  status: StatusPill;
  isSending: boolean;
  sendingChatId: string | null;
  sendingOperations: Record<string, string>;
  retryingTurnId: string | null;
  creatingProject: boolean;
  commandOpen: boolean;
  renameProject: ProjectSummary | null;
  renameSession: SessionSummary | null;
  setLeftOpen: (value: Updater<boolean>) => void;
  setRightOpen: (value: Updater<boolean>) => void;
  setRightTab: (rightTab: string) => void;
  setSelectedArtifactId: (artifactId: string | null) => void;
  openArtifact: (artifactId: string, artifact?: SessionArtifactSummary) => void;
  setLeftPanelWidth: (leftPanelWidth: number) => void;
  setRightPanelWidth: (rightPanelWidth: number) => void;
  setSidebarChatsCollapsed: (value: Updater<boolean>) => void;
  setSidebarProjectsCollapsed: (value: Updater<boolean>) => void;
  setSidebarCollapsedProjectIds: (projectIds: Updater<string[]>) => void;
  hydrateUiState: (uiState: AppUiStateSnapshot) => void;
  setView: (view: AppView) => void;
  openSettings: (section?: SettingsSectionId | string) => void;
  closeSettings: () => void;
  setActiveChatId: (activeChatId: string) => void;
  setNavigation: (navigation: NavigationView) => void;
  setMessages: (messages: Updater<MessageRecord[]>) => void;
  setMessageListView: (view: MessageListView) => void;
  setSessionView: (view: SessionView) => void;
  setSummary: (summary: Updater<SessionSummaryView | null>) => void;
  setTurnProgress: (
    turnProgress: Updater<Record<string, TurnProgressSnapshot>>,
  ) => void;
  applyTimelineEvents: (events: TimelineEvent[]) => void;
  setSettings: (settings: SettingsView) => void;
  setModelCatalog: (modelCatalog: ModelCatalogView) => void;
  setModelCatalogState: (modelCatalogState: ModelCatalogState) => void;
  setStatus: (status: Updater<StatusPill>) => void;
  setIsSending: (isSending: boolean) => void;
  setRetryingTurnId: (retryingTurnId: string | null) => void;
  setCreatingProject: (creatingProject: boolean) => void;
  setCommandOpen: (commandOpen: boolean) => void;
  setRenameProject: (renameProject: ProjectSummary | null) => void;
  setRenameSession: (renameSession: SessionSummary | null) => void;
  openSession: (chatId: string) => void;
  openNewChat: () => void;
  openNewProjectChat: (projectId: string) => void;
  startProjectChatWithDocument: (
    projectId: string,
    document: ProjectDashboardDocument,
  ) => void;
  clearPendingProjectDocumentAttachment: () => void;
  openProjectDashboard: (projectId: string) => void;
  refreshNavigation: () => Promise<void>;
  refreshSessionView: (chatId?: string) => Promise<void>;
  reloadMessages: (chatId?: string) => Promise<void>;
  refreshSessionSummary: (chatId?: string) => Promise<void>;
  sendMessage: (text: string, controls?: ComposerControls) => Promise<void>;
  refreshSessionQueue: (chatId?: string) => Promise<void>;
  queueMessage: (text: string, controls?: ComposerControls) => Promise<void>;
  updateQueuedMessage: (
    queuedMessageId: string,
    text: string,
    controls?: ComposerControls,
  ) => Promise<void>;
  deleteQueuedMessage: (queuedMessageId: string) => Promise<void>;
  cancelActiveTurn: () => Promise<void>;
  createScratchProject: () => Promise<void>;
  createProjectFromExistingFolder: () => Promise<void>;
  runProjectAction: (
    project: ProjectSummary,
    action: ProjectAction,
  ) => Promise<void>;
  runSessionAction: (
    session: SessionSummary,
    action: SessionAction,
  ) => Promise<void>;
  submitProjectRename: (
    project: ProjectSummary,
    displayName: string,
  ) => Promise<void>;
  submitSessionRename: (
    session: SessionSummary,
    title: string,
  ) => Promise<void>;
  retryTurn: (turnId: string) => Promise<void>;
  controlWorker: (workerId: string, action: string) => Promise<void>;
  exportTranscript: () => Promise<void>;
  navigateCommandResult: (result: CommandPaletteResult) => void;
}

function resolveUpdate<T>(update: Updater<T>, previous: T): T {
  return typeof update === "function"
    ? (update as (previous: T) => T)(previous)
    : update;
}

function structurallyEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function messageRecordsEqual(
  left: MessageRecord[] | undefined,
  right: MessageRecord[] | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right || left.length !== right.length) return false;
  return left.every((message, index) => {
    const other = right[index];
    return (
      Boolean(other) &&
      message.id === other.id &&
      message.cursor === other.cursor &&
      message.role === other.role &&
      message.status === other.status &&
      message.turn_id === other.turn_id &&
      message.text === other.text &&
      message.delivery_state === other.delivery_state &&
      structurallyEqual(message.limitation_codes ?? [], other.limitation_codes ?? []) &&
      structurallyEqual(message.limitations ?? [], other.limitations ?? []) &&
      structurallyEqual(message.attachments ?? [], other.attachments ?? []) &&
      structurallyEqual(message.artifacts ?? [], other.artifacts ?? []) &&
      structurallyEqual(message.work_blocks ?? [], other.work_blocks ?? [])
    );
  });
}

function reusePreviousMessageRecord(
  previousById: Map<string, MessageRecord>,
  message: MessageRecord,
): MessageRecord {
  const previous = previousById.get(message.id);
  return previous && messageRecordsEqual([previous], [message])
    ? previous
    : message;
}

function completedSendingOperationState(
  state: ButlerStore,
  sendOperationId: string,
): Pick<ButlerStore, "isSending" | "sendingChatId" | "sendingOperations"> {
  const sendingOperations = { ...state.sendingOperations };
  delete sendingOperations[sendOperationId];
  const sendingChatIds = Object.values(sendingOperations);
  return {
    isSending: sendingChatIds.length > 0,
    sendingChatId: sendingChatIds.at(-1) ?? null,
    sendingOperations,
  };
}

function completedSendingOperationsForChatState(
  state: ButlerStore,
  chatId: string,
): Pick<ButlerStore, "isSending" | "sendingChatId" | "sendingOperations"> {
  const sendingOperations = Object.fromEntries(
    Object.entries(state.sendingOperations).filter(
      ([, operationChatId]) => operationChatId !== chatId,
    ),
  );
  const sendingChatIds = Object.values(sendingOperations);
  return {
    isSending: sendingChatIds.length > 0,
    sendingChatId: sendingChatIds.at(-1) ?? null,
    sendingOperations,
  };
}

function hasDeliveredAssistantEvent(
  events: TimelineEvent[],
  chatId: string,
): boolean {
  return events.some((event) => {
    if (event.type !== "message.created" && event.type !== "message.updated") {
      return false;
    }
    const message = event.payload?.message;
    return (
      message?.chat_id === chatId &&
      message.role === "assistant" &&
      message.status !== "pending" &&
      message.status !== "streaming"
    );
  });
}

function summaryAfterImmediateAssistantReply(
  summary: SessionSummaryView | null,
  replies: MessageRecord[],
): SessionSummaryView | null {
  const finalReply = [...replies]
    .reverse()
    .find((message) => message.role === "assistant" && message.turn_id);
  if (!summary || !finalReply?.turn_id) return summary;
  return {
    ...summary,
    turn_state: "delivered",
    latest_progress: {
      turn_id: finalReply.turn_id,
      state: "delivered",
      updated_at: finalReply.updated_at,
      safe_progress_rows: [],
    },
  };
}

function completeSessionView(
  chatId: string,
  messages: MessageRecord[],
  turnProgress: Record<string, TurnProgressSnapshot>,
  nextCursor?: number,
): MessageListView | null {
  if (isDraftChatId(chatId) || messages.length === 0) return null;
  const view = {
    chat_id: chatId,
    messages,
    turn_progress: turnProgress,
    next_cursor: nextCursor ?? messageListCursor({ messages }),
  };
  return messageListSyncCursor(view) > 0 ? view : null;
}

function upsertCompleteSessionView(
  views: Record<string, MessageListView>,
  view: MessageListView | null,
): Record<string, MessageListView> {
  if (!view?.chat_id || messageListSyncCursor(view) === 0) return views;
  const previous = views[view.chat_id];
  if (
    previous &&
    messageRecordsEqual(previous.messages, view.messages) &&
    structurallyEqual(previous.turn_progress ?? {}, view.turn_progress ?? {}) &&
    previous.next_cursor === view.next_cursor
  ) {
    return views;
  }
  return { ...views, [view.chat_id]: view };
}

function snapshotActiveSessionView(
  state: ButlerStore,
): Record<string, MessageListView> {
  return upsertCompleteSessionView(
    state.sessionMessageViews,
    completeSessionView(state.activeChatId, state.messages, state.turnProgress),
  );
}

function applyMessageListView(
  state: ButlerStore,
  view: MessageListView,
): ButlerStore | Partial<ButlerStore> {
  const chatId = view.chat_id ?? state.activeChatId;
  const incomingTurnProgress = view.turn_progress ?? {};
  const mergedTurnProgress =
    state.activeChatId === chatId
      ? mergeTurnProgressSnapshotMap(state.turnProgress, incomingTurnProgress)
      : incomingTurnProgress;
  const previousById = new Map(
    state.messages.map((message) => [message.id, message]),
  );
  const sameSessionMessages =
    state.activeChatId === chatId
      ? state.messages.filter((message) => message.chat_id === chatId)
      : [];
  const sourceMessages =
    sameSessionMessages.length > 0
      ? mergeMessages(sameSessionMessages, view.messages ?? [])
      : (view.messages ?? []);
  const prunedTurnProgress = pruneReplacedClientTurnProgress(
    mergedTurnProgress,
    sourceMessages,
  );
  const messages = freezeMessageWorkBlocks(
    sourceMessages.map((message) => {
      const previous = previousById.get(message.id);
      return previous?.work_blocks?.length && !message.work_blocks
        ? { ...message, work_blocks: previous.work_blocks }
        : message;
    }),
    prunedTurnProgress,
  ).map((message) => reusePreviousMessageRecord(previousById, message));
  const sessionMessageViews = upsertCompleteSessionView(
    state.sessionMessageViews,
    completeSessionView(chatId, messages, prunedTurnProgress, view.next_cursor),
  );
  if (
    messageRecordsEqual(state.messages, messages) &&
    structurallyEqual(state.turnProgress, prunedTurnProgress) &&
    state.sessionMessageViews === sessionMessageViews &&
    !state.messageLoadPending
  ) {
    return state;
  }
  return {
    messages: messageRecordsEqual(state.messages, messages)
      ? state.messages
      : messages,
    turnProgress: structurallyEqual(state.turnProgress, prunedTurnProgress)
      ? state.turnProgress
      : prunedTurnProgress,
    sessionMessageViews,
    messageLoadPending: false,
  };
}

function messageListViewFromSessionView(view: SessionView): MessageListView {
  const turnProgress =
    view.latest_turn?.id && view.latest_turn.progress
      ? { [view.latest_turn.id]: view.latest_turn.progress }
      : {};
  return {
    chat_id: view.session_id,
    messages: view.messages,
    turn_progress: turnProgress,
    next_cursor: view.message_window.next_cursor,
  };
}

function summaryFromSessionView(view: SessionView): SessionSummaryView {
  const latestProgress = view.latest_turn?.progress ?? {
    state: "idle",
    safe_progress_rows: [],
    updated_at: view.updated_at,
  };
  return {
    session_id: view.session_id,
    turn_state: view.latest_turn?.state ?? "idle",
    latest_progress: latestProgress,
    branch_info: view.branch ?? undefined,
    context_details: view.context ?? undefined,
    artifacts: view.artifacts,
    automation_targets: view.automations,
    skills_used: view.skills_used ?? [],
    worker_activity: view.workers.filter((worker) =>
      isWorkerVisibleInComposer(worker),
    ),
    work_streams: view.work_streams,
  };
}

function mergeWorkerActivityForActiveSummary(
  current: SessionSummaryView | null,
  incoming: SessionSummaryView,
): SessionSummaryView {
  const currentWorkers = current?.worker_activity ?? [];
  if (currentWorkers.length === 0) return incoming;
  const incomingWorkers = incoming.worker_activity ?? [];
  const incomingById = new Set(
    incomingWorkers.map((worker) => worker.worker_id),
  );
  const incomingParentKeys = new Set(
    incomingWorkers
      .filter((worker) => worker.activity_kind === "planned")
      .map((worker) => worker.task_id ?? worker.orchestration_id)
      .filter((key): key is string => Boolean(key)),
  );
  const incomingState =
    incoming.latest_progress?.state ?? incoming.turn_state ?? "";
  const shouldPreserveActiveWorkers = isNonTerminalTurnState(incomingState);
  if (!shouldPreserveActiveWorkers) return incoming;
  const preserved = currentWorkers.filter(
    (worker) =>
      isWorkerVisibleInComposer(worker) &&
      !incomingById.has(worker.worker_id) &&
      !(
        worker.activity_kind === "worker" &&
        worker.orchestration_id &&
        incomingParentKeys.has(worker.orchestration_id)
      ),
  );
  if (preserved.length === 0) return incoming;
  return {
    ...incoming,
    worker_activity: [...incomingWorkers, ...preserved],
  };
}

function isNonTerminalTurnState(state: string): boolean {
  return (
    Boolean(state) &&
    ![
      "failed",
      "cancelled",
      "delivered",
      "complete",
      "completed",
      "idle",
    ].includes(state)
  );
}

function applySessionView(
  state: ButlerStore,
  view: SessionView,
): ButlerStore | Partial<ButlerStore> {
  const messageListView = messageListViewFromSessionView(view);
  const incomingSummary = summaryFromSessionView(view);
  const previousSummary =
    state.summary?.session_id === view.session_id ? state.summary : null;
  const summary = mergeWorkerActivityForActiveSummary(
    previousSummary,
    mergeSessionSummaryForPendingTurn(previousSummary, incomingSummary),
  );
  const previousTurnProgress =
    state.activeChatId === view.session_id ? state.turnProgress : {};
  const summaryTurnProgress = mergeTurnProgressFromSummary(
    previousTurnProgress,
    summary,
  );
  const mergedTurnProgress = mergeTurnProgressSnapshotMap(
    summaryTurnProgress,
    messageListView.turn_progress ?? {},
  );
  const previousById = new Map(
    state.messages.map((message) => [message.id, message]),
  );
  const sameSessionMessages =
    state.activeChatId === view.session_id
      ? state.messages.filter((message) => message.chat_id === view.session_id)
      : [];
  const sourceMessages =
    sameSessionMessages.length > 0
      ? mergeMessages(sameSessionMessages, messageListView.messages ?? [])
      : (messageListView.messages ?? []);
  const turnProgress = pruneReplacedClientTurnProgress(
    mergedTurnProgress,
    sourceMessages,
  );
  const messages = sourceMessages.map((message) => {
    const previous = previousById.get(message.id);
    const retainedMessage =
      previous?.work_blocks?.length && !message.work_blocks
        ? { ...message, work_blocks: previous.work_blocks }
        : message;
    const frozen = freezeMessageWorkBlocksForRecord(
      retainedMessage,
      retainedMessage.turn_id
        ? turnProgress[retainedMessage.turn_id]
        : undefined,
    );
    return reusePreviousMessageRecord(previousById, frozen);
  });
  const sessionMessageViews = upsertCompleteSessionView(
    state.sessionMessageViews,
    completeSessionView(
      view.session_id,
      messages,
      turnProgress,
      view.message_window.next_cursor,
    ),
  );
  return {
    messages: messageRecordsEqual(state.messages, messages)
      ? state.messages
      : messages,
    turnProgress: structurallyEqual(state.turnProgress, turnProgress)
      ? state.turnProgress
      : turnProgress,
    summary: structurallyEqual(state.summary, summary)
      ? state.summary
      : summary,
    sessionView: structurallyEqual(state.sessionView, view)
      ? state.sessionView
      : view,
    sessionMessageViews,
    messageLoadPending: false,
  };
}

const initialSettings = readCachedSettings();
setAppCopyLanguage(initialSettings.language);

export const useButlerStore = create<ButlerStore>((set, get) => ({
  leftOpen: false,
  rightOpen: true,
  rightTab: "summary",
  selectedArtifactId: null,
  selectedArtifact: null,
  leftPanelWidth: DEFAULT_LEFT_PANEL_WIDTH,
  rightPanelWidth: DEFAULT_RIGHT_PANEL_WIDTH,
  sidebarChatsCollapsed: false,
  sidebarProjectsCollapsed: false,
  sidebarCollapsedProjectIds: [],
  view: { kind: "session" },
  settingsReturnView: { kind: "session" },
  activeChatId: "draft:chat",
  navigation: EMPTY_NAVIGATION,
  messages: [],
  sessionView: null,
  messageLoadPending: false,
  optimisticSessionStart: null,
  pendingProjectDocumentAttachment: null,
  sessionMessageViews: {},
  summary: null,
  turnProgress: {},
  sessionQueue: [],
  settings: initialSettings,
  modelCatalog: EMPTY_MODEL_CATALOG,
  modelCatalogState: "loading",
  status: { label: "connecting", tone: "muted" },
  isSending: false,
  sendingChatId: null,
  sendingOperations: {},
  retryingTurnId: null,
  creatingProject: false,
  commandOpen: false,
  renameProject: null,
  renameSession: null,

  setLeftOpen: (value) =>
    set((state) => {
      const leftOpen = resolveUpdate(value, state.leftOpen);
      return leftOpen
        ? normalizeAdaptivePanelState({
            mode: currentAdaptiveMode(),
            requested: "left",
            leftOpen,
            rightOpen: state.rightOpen,
          })
        : { leftOpen: false };
    }),
  setRightOpen: (value) =>
    set((state) => {
      const rightOpen = resolveUpdate(value, state.rightOpen);
      return rightOpen
        ? normalizeAdaptivePanelState({
            mode: currentAdaptiveMode(),
            requested: "right",
            leftOpen: state.leftOpen,
            rightOpen,
          })
        : { rightOpen: false };
    }),
  setRightTab: (rightTab) => set({ rightTab }),
  setSelectedArtifactId: (artifactId) =>
    set({ selectedArtifactId: artifactId, selectedArtifact: null }),
  openArtifact: (artifactId, artifact) =>
    set((state) => ({
      ...normalizeAdaptivePanelState({
        mode: currentAdaptiveMode(),
        requested: "right",
        leftOpen: state.leftOpen,
        rightOpen: true,
      }),
      rightTab: "artifacts",
      selectedArtifactId: artifactId,
      selectedArtifact: artifact ?? null,
    })),
  setLeftPanelWidth: (leftPanelWidth) => set({ leftPanelWidth }),
  setRightPanelWidth: (rightPanelWidth) => set({ rightPanelWidth }),
  setSidebarChatsCollapsed: (value) =>
    set((state) => ({
      sidebarChatsCollapsed: resolveUpdate(value, state.sidebarChatsCollapsed),
    })),
  setSidebarProjectsCollapsed: (value) =>
    set((state) => ({
      sidebarProjectsCollapsed: resolveUpdate(
        value,
        state.sidebarProjectsCollapsed,
      ),
    })),
  setSidebarCollapsedProjectIds: (projectIds) =>
    set((state) => ({
      sidebarCollapsedProjectIds: resolveUpdate(
        projectIds,
        state.sidebarCollapsedProjectIds,
      ),
    })),
  hydrateUiState: (uiState) => {
    const panels = restoreAdaptivePanelState({
      mode: currentAdaptiveMode(),
      leftOpen: uiState.left_open,
      rightOpen: uiState.right_open,
    });
    set({
      activeChatId: uiState.active_session_id,
      view: { kind: "session" },
      ...panels,
      rightTab: uiState.right_tab,
      leftPanelWidth: uiState.left_panel_width,
      rightPanelWidth: uiState.right_panel_width,
      sidebarChatsCollapsed: uiState.sidebar_chats_collapsed,
      sidebarProjectsCollapsed: uiState.sidebar_projects_collapsed,
      sidebarCollapsedProjectIds: uiState.sidebar_collapsed_project_ids,
    });
  },
  setView: (view) => set({ view }),
  openSettings: (section = "general") =>
    set((state) => ({
      settingsReturnView:
        state.view.kind === "settings" ? state.settingsReturnView : state.view,
      view: { kind: "settings", section: normalizeSettingsSectionId(section) },
    })),
  closeSettings: () =>
    set((state) => ({
      view: state.settingsReturnView ?? { kind: "session" },
    })),
  setActiveChatId: (activeChatId) =>
    set({ activeChatId, selectedArtifactId: null, selectedArtifact: null }),
  setNavigation: (navigation) =>
    set((state) => {
      const nextNavigation = navigationWithOptimisticSession(
        navigation,
        state.optimisticSessionStart,
      );
      const activeLocalSession = findSessionSummary(
        state.navigation,
        state.activeChatId,
      );
      const displayedNavigation =
        state.isSending &&
        activeLocalSession &&
        !findSessionSummary(nextNavigation, state.activeChatId)
          ? navigationWithSessionSummary(nextNavigation, activeLocalSession)
          : nextNavigation;
      return structurallyEqual(state.navigation, displayedNavigation)
        ? state
        : { navigation: displayedNavigation };
    }),
  setMessages: (messages) =>
    set((state) => {
      const nextMessages = resolveUpdate(messages, state.messages);
      const frozenMessages = freezeMessageWorkBlocks(
        nextMessages,
        state.turnProgress,
      );
      return messageRecordsEqual(state.messages, frozenMessages)
        ? state
        : { messages: frozenMessages };
    }),
  setMessageListView: (view) =>
    set((state) => applyMessageListView(state, view)),
  setSessionView: (view) => set((state) => applySessionView(state, view)),
  setSummary: (summary) =>
    set((state) => {
      const resolvedSummary = resolveUpdate(summary, state.summary);
      const nextSummary = structurallyEqual(state.summary, resolvedSummary)
        ? state.summary
        : resolvedSummary;
      const turnProgress = mergeTurnProgressFromSummary(
        state.turnProgress,
        nextSummary,
      );
      const messages = freezeMessageWorkBlocks(state.messages, turnProgress);
      if (
        state.summary === nextSummary &&
        state.turnProgress === turnProgress &&
        state.messages === messages
      ) {
        return state;
      }
      return {
        summary: nextSummary,
        turnProgress,
        messages,
      };
    }),
  setTurnProgress: (turnProgress) =>
    set((state) => {
      const nextTurnProgress = resolveUpdate(turnProgress, state.turnProgress);
      const resolvedTurnProgress =
        state.turnProgress === nextTurnProgress ||
        structurallyEqual(state.turnProgress, nextTurnProgress)
          ? state.turnProgress
          : nextTurnProgress;
      const messages = freezeMessageWorkBlocks(
        state.messages,
        resolvedTurnProgress,
      );
      return state.turnProgress === resolvedTurnProgress &&
        state.messages === messages
        ? state
        : { turnProgress: resolvedTurnProgress, messages };
    }),
  applyTimelineEvents: (events) =>
    set((state) => {
      const next = applyTimelineEventsToViewState(events, state.activeChatId, {
        messages: state.messages,
        summary: state.summary,
        turnProgress: state.turnProgress,
      });
      const completedSendState = hasDeliveredAssistantEvent(
        events,
        state.activeChatId,
      )
        ? completedSendingOperationsForChatState(state, state.activeChatId)
        : null;
      if (
        next.messages === state.messages &&
        next.summary === state.summary &&
        next.turnProgress === state.turnProgress &&
        !completedSendState
      ) {
        return state;
      }
      return {
        ...next,
        ...(completedSendState ?? {}),
      };
    }),
  setSettings: (settings) =>
    set((state) => {
      const nextSettings = settingsWithDefaults(settings);
      setAppCopyLanguage(nextSettings.language);
      writeCachedSettings(nextSettings);
      return structurallyEqual(state.settings, nextSettings)
        ? state
        : { settings: nextSettings };
    }),
  setModelCatalog: (modelCatalog) =>
    set((state) => {
      const modelCatalogState =
        runtimeModels(modelCatalog).length > 0 ? "ready" : "unavailable";
      if (
        structurallyEqual(state.modelCatalog, modelCatalog) &&
        state.modelCatalogState === modelCatalogState
      ) {
        return state;
      }
      return { modelCatalog, modelCatalogState };
    }),
  setModelCatalogState: (modelCatalogState) => set({ modelCatalogState }),
  setStatus: (status) =>
    set((state) => {
      const nextStatus = resolveUpdate(status, state.status);
      return structurallyEqual(state.status, nextStatus)
        ? state
        : { status: nextStatus };
    }),
  setIsSending: (isSending) =>
    set((state) => ({
      isSending,
      sendingChatId: isSending
        ? (state.sendingChatId ?? state.activeChatId)
        : null,
      sendingOperations: isSending ? state.sendingOperations : {},
    })),
  setRetryingTurnId: (retryingTurnId) => set({ retryingTurnId }),
  setCreatingProject: (creatingProject) => set({ creatingProject }),
  setCommandOpen: (commandOpen) => set({ commandOpen }),
  setRenameProject: (renameProject) => set({ renameProject }),
  setRenameSession: (renameSession) => set({ renameSession }),

  openSession: (chatId) =>
    set((state) => {
      const sessionMessageViews = snapshotActiveSessionView(state);
      const memoryView = sessionMessageViews[chatId];
      const cached =
        memoryView && messageListSyncCursor(memoryView) > 0
          ? memoryView
          : readCachedMessageListSync(chatId);
      const completeCached = cached && messageListSyncCursor(cached) > 0;
      const turnProgress = cached?.turn_progress ?? {};
      const nextSessionMessageViews = completeCached
        ? upsertCompleteSessionView(sessionMessageViews, {
            ...cached,
            chat_id: chatId,
          })
        : sessionMessageViews;
      return {
        activeChatId: chatId,
        view: { kind: "session" },
        selectedArtifactId: null,
        selectedArtifact: null,
        summary: null,
        sessionView: null,
        sessionQueue: [],
        messages: completeCached
          ? freezeMessageWorkBlocks(cached.messages, turnProgress)
          : [],
        turnProgress: completeCached ? turnProgress : {},
        sessionMessageViews: nextSessionMessageViews,
        messageLoadPending:
          isServerBackedSessionId(chatId) && !completeCached,
        status: state.status,
      };
    }),
  openNewChat: () => get().openSession("draft:chat"),
  openNewProjectChat: (projectId) =>
    get().openSession(projectDraftId(projectId)),
  startProjectChatWithDocument: (projectId, document) => {
    set({ pendingProjectDocumentAttachment: { projectId, document } });
    get().openNewProjectChat(projectId);
  },
  clearPendingProjectDocumentAttachment: () =>
    set({ pendingProjectDocumentAttachment: null }),
  openProjectDashboard: (projectId) =>
    set({
      view: { kind: "project-dashboard", projectId },
      selectedArtifactId: null,
      selectedArtifact: null,
    }),

  refreshNavigation: async () => {
    try {
      const data = await api<NavigationView>("/navigation");
      get().setNavigation(data);
    } catch {
      // Navigation refresh is opportunistic; message delivery should remain visible.
    }
  },

  refreshSessionView: async (chatId = get().activeChatId) => {
    if (!isServerBackedSessionId(chatId)) return;
    try {
      const data = await api<SessionView>(
        `/session-view?session_id=${encodeURIComponent(chatId)}`,
      );
      if (get().activeChatId !== chatId) return;
      set((state) => applySessionView(state, data));
      void writeCachedMessageList(chatId, messageListViewFromSessionView(data));
    } catch {
      // Keep the last canonical snapshot visible on transient failures.
    }
  },

  reloadMessages: async (chatId = get().activeChatId) => {
    if (!isServerBackedSessionId(chatId)) return;
    let cached: MessageListView | null = null;
    try {
      try {
        cached = await readCachedMessageList(chatId);
      } catch {
        // Cache reads are opportunistic; fall through to the server.
      }
      if (get().activeChatId !== chatId) return;
      if (cached) {
        const cursor = messageListSyncCursor(cached);
        if (cursor > 0) {
          set((state) => applyMessageListView(state, cached!));
        }
      }
      const snapshot = await api<SessionView>(
        `/session-view?session_id=${encodeURIComponent(chatId)}`,
      );
      if (get().activeChatId !== chatId) return;
      set((state) => applySessionView(state, snapshot));
      void writeCachedMessageList(
        chatId,
        messageListViewFromSessionView(snapshot),
      );
    } catch {
      // Keep the already visible timeline if refresh fails; the status pill carries the error.
    }
  },

  refreshSessionSummary: async (chatId = get().activeChatId) => {
    if (!isServerBackedSessionId(chatId)) return;
    try {
      const data = await api<SessionView>(
        `/session-view?session_id=${encodeURIComponent(chatId)}`,
      );
      if (get().activeChatId !== chatId) return;
      set((state) => applySessionView(state, data));
      void writeCachedMessageList(chatId, messageListViewFromSessionView(data));
    } catch {
      // Preserve the visible turn summary on transient refresh failures.
      // The live event stream is authoritative enough to keep the UI stable.
    }
  },

  refreshSessionQueue: async (chatId = get().activeChatId) => {
    if (!isServerBackedSessionId(chatId)) {
      if (get().activeChatId === chatId) set({ sessionQueue: [] });
      return;
    }
    try {
      const data = await api<SessionQueueView>(
        `/session-queue?session_id=${encodeURIComponent(chatId)}`,
      );
      if (get().activeChatId !== chatId) return;
      set({ sessionQueue: data.queued_messages });
    } catch {
      if (get().activeChatId === chatId) set({ sessionQueue: [] });
    }
  },

  queueMessage: async (text, controls = {}) => {
    const targetChatId = get().activeChatId;
    if (isDraftChatId(targetChatId)) {
      await get().sendMessage(text, controls);
      return;
    }
    const attachments = controls.attachments ?? [];
    try {
      const data = await api<SessionQueueView>("/session-queue", {
        method: "POST",
        body: JSON.stringify({
          chat_id: targetChatId,
          text,
          model: controls.model,
          reasoning_effort: controls.reasoningEffort,
          access_mode: controls.accessMode,
          plan_mode: controls.planMode,
          attachments: attachments.map((attachment) => ({
            file_id: attachment.file_id,
          })),
        }),
      });
      if (get().activeChatId === targetChatId) {
        set({
          sessionQueue: data.queued_messages,
          status: { label: "ready", tone: "ok" },
        });
      }
    } catch (error) {
      notifyError(error, "Message queue failed", {
        id: `queue-message-${targetChatId}`,
      });
    }
  },

  updateQueuedMessage: async (queuedMessageId, text, controls = {}) => {
    const targetChatId = get().activeChatId;
    const attachments = controls.attachments ?? [];
    try {
      const data = await api<SessionQueueView>(
        `/session-queue/${encodeURIComponent(queuedMessageId)}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            text,
            model: controls.model,
            reasoning_effort: controls.reasoningEffort,
            access_mode: controls.accessMode,
            plan_mode: controls.planMode,
            attachments: attachments.map((attachment) => ({
              file_id: attachment.file_id,
            })),
          }),
        },
      );
      if (get().activeChatId === targetChatId)
        set({ sessionQueue: data.queued_messages });
    } catch (error) {
      notifyError(error, "Queued message update failed", {
        id: `update-queued-message-${queuedMessageId}`,
      });
    }
  },

  deleteQueuedMessage: async (queuedMessageId) => {
    const targetChatId = get().activeChatId;
    set((state) => ({
      sessionQueue: state.sessionQueue.filter(
        (message) => message.id !== queuedMessageId,
      ),
    }));
    try {
      const data = await api<SessionQueueView>(
        `/session-queue/${encodeURIComponent(queuedMessageId)}`,
        { method: "DELETE" },
      );
      if (get().activeChatId === targetChatId)
        set({ sessionQueue: data.queued_messages });
    } catch (error) {
      notifyError(error, "Queued message delete failed", {
        id: `delete-queued-message-${queuedMessageId}`,
      });
    }
  },

  sendMessage: async (text, controls = {}) => {
    const clientMessageId = browserRandomId("client");
    const clientTurnId = clientTurnIdFromMessageId(clientMessageId);
    const attachments = controls.attachments ?? [];
    const messageTitle = text.trim() || attachments[0]?.safe_name || "New chat";
    const startedAt = new Date().toISOString();
    const initialChatId = get().activeChatId;
    const sendOperationId = `send-${clientMessageId}`;
    const initialDraft = isDraftChatId(initialChatId)
      ? parseDraftChatId(initialChatId)
      : null;
    const optimisticStart: OptimisticSessionStart | null = initialDraft
      ? {
          id: optimisticSessionId(clientMessageId),
          kind: initialDraft.kind ?? "chat",
          projectId: initialDraft.projectId,
          title: titleFromPrompt(messageTitle),
          statusLabel: appCopy.sidebar.newSessionStarting,
          startedAt,
        }
      : null;
    set((state) => ({
      isSending: true,
      sendingChatId: optimisticStart?.id ?? initialChatId,
      sendingOperations: {
        ...state.sendingOperations,
        [sendOperationId]: optimisticStart?.id ?? initialChatId,
      },
      status: {
        label: optimisticStart?.statusLabel ?? "thinking",
        tone: "muted",
      },
      activeChatId: optimisticStart?.id ?? state.activeChatId,
      view: optimisticStart ? { kind: "session" } : state.view,
      selectedArtifactId: optimisticStart ? null : state.selectedArtifactId,
      selectedArtifact: optimisticStart ? null : state.selectedArtifact,
      navigation: optimisticStart
        ? navigationWithOptimisticSession(state.navigation, optimisticStart)
        : state.navigation,
      messages: optimisticStart
        ? [
            {
              id: clientMessageId,
              chat_id: optimisticStart.id,
              role: "user",
              text,
              attachments,
              status: "pending",
              retryable: false,
              cursor: 0.5,
              created_at: startedAt,
              updated_at: startedAt,
            },
          ]
        : state.messages,
      turnProgress: optimisticStart ? {} : state.turnProgress,
      sessionView: optimisticStart ? null : state.sessionView,
      messageLoadPending: optimisticStart ? false : state.messageLoadPending,
      optimisticSessionStart: optimisticStart ?? state.optimisticSessionStart,
      summary: optimisticStart
        ? {
            session_id: optimisticStart.id,
            turn_state: "session_starting",
            latest_progress: {
              turn_id: clientTurnId,
              summary: appCopy.sidebar.newSessionStarting,
              state: "session_starting",
              updated_at: startedAt,
              safe_progress_rows: [],
            },
            artifacts: [],
            skills_used: [],
            worker_activity: [],
            work_streams: [],
          }
        : state.summary
        ? {
            ...state.summary,
            turn_state: "thinking",
            latest_progress: {
              turn_id: clientTurnId,
              summary: "Thinking",
              state: "thinking",
              updated_at: startedAt,
              safe_progress_rows: [
                {
                  id: `thinking-${clientMessageId}`,
                  kind: "thinking",
                  state: "thinking",
                  safe_label: "Thinking",
                  created_at: startedAt,
                },
              ],
            },
          }
        : state.summary,
    }));
    let targetChatId = optimisticStart?.id ?? get().activeChatId;
    try {
      if (optimisticStart && initialDraft) {
        const session = await api<{ session: SessionSummary }>("/sessions", {
          method: "POST",
          body: JSON.stringify({
            kind: initialDraft.kind,
            project_id: initialDraft.projectId,
            title: titleFromPrompt(messageTitle),
            initial_message: text,
          }),
        });
        const previousChatId = targetChatId;
        targetChatId = session.session.id;
        set((state) => ({
          activeChatId:
            state.activeChatId === previousChatId
              ? targetChatId
              : state.activeChatId,
          sendingChatId:
            state.sendingChatId === previousChatId
              ? targetChatId
              : state.sendingChatId,
          sendingOperations: {
            ...state.sendingOperations,
            [sendOperationId]: targetChatId,
          },
          view: { kind: "session" },
          selectedArtifactId: null,
          selectedArtifact: null,
          navigation: navigationReplacingOptimisticSession(
            state.navigation,
            previousChatId,
            session.session,
          ),
          messages: messagesWithChatId(
            state.messages,
            previousChatId,
            targetChatId,
          ),
          summary: summaryWithSessionId(
            state.summary,
            previousChatId,
            targetChatId,
          ),
          optimisticSessionStart:
            state.optimisticSessionStart?.id === previousChatId
              ? null
              : state.optimisticSessionStart,
        }));
      }
      if (!optimisticStart) {
        const optimisticCursor =
          Math.max(
            0,
            ...get().messages.map((message) => Number(message.cursor ?? 0)),
          ) + 0.5;
        const optimisticCreatedAt = new Date().toISOString();
        set((state) => ({
          messages: mergeMessages(state.messages, [
            {
              id: clientMessageId,
              chat_id: targetChatId,
              role: "user",
              text,
              attachments,
              status: "pending",
              retryable: false,
              cursor: optimisticCursor,
              created_at: optimisticCreatedAt,
              updated_at: optimisticCreatedAt,
            },
          ]),
        }));
      }
      const result = await api<{
        accepted?: MessageRecord;
        queued?: QueuedMessageRecord;
        replies?: MessageRecord[];
        reply?: MessageRecord;
      }>("/messages", {
        method: "POST",
        body: JSON.stringify({
          chat_id: targetChatId,
          text,
          client_message_id: clientMessageId,
          model: controls.model,
          reasoning_effort: controls.reasoningEffort,
          access_mode: controls.accessMode,
          plan_mode: controls.planMode,
          queue_policy: controls.queuePolicy,
          attachments: attachments.map((attachment) => ({
            file_id: attachment.file_id,
          })),
        }),
      });
      if (result.queued && !result.accepted) {
        set((state) => ({
          messages: state.messages.filter(
            (message) => message.id !== clientMessageId,
          ),
          sessionQueue: [...state.sessionQueue, result.queued!],
        }));
        await get().refreshSessionQueue(targetChatId);
        set({ status: { label: "ready", tone: "ok" } });
        return;
      }
      if (!result.accepted) {
        throw new Error("Message send returned no accepted message.");
      }
      const accepted = result.accepted;
      const replies = result.replies ?? (result.reply ? [result.reply] : []);
      const hasImmediateAssistantReply = replies.length > 0;
      set((state) => {
        const mergedMessages = mergeMessages(
          state.messages.filter((message) => message.id !== clientMessageId),
          [accepted, ...replies],
        );
        const prunedTurnProgress = pruneReplacedClientTurnProgress(
          state.turnProgress,
          mergedMessages,
        );
        const messages = freezeMessageWorkBlocks(
          mergedMessages,
          prunedTurnProgress,
        );
        const completedSendState = hasImmediateAssistantReply
          ? completedSendingOperationState(state, sendOperationId)
          : null;
        const summary = hasImmediateAssistantReply
          ? summaryAfterImmediateAssistantReply(state.summary, replies)
          : state.summary;
        return {
          messages: messageRecordsEqual(state.messages, messages)
            ? state.messages
            : messages,
          summary: structurallyEqual(state.summary, summary)
            ? state.summary
            : summary,
          turnProgress: structurallyEqual(
            state.turnProgress,
            prunedTurnProgress,
          )
            ? state.turnProgress
            : prunedTurnProgress,
          ...(completedSendState ?? {}),
        };
      });
      await get().refreshNavigation();
      await get().refreshSessionSummary(targetChatId);
      await get().refreshSessionQueue(targetChatId);
      if (!hasImmediateAssistantReply) await get().reloadMessages(targetChatId);
      set({ status: { label: "ready", tone: "ok" } });
    } catch (error) {
      if (isServerBackedSessionId(targetChatId)) {
        await get().reloadMessages(targetChatId);
      }
      set((state) => ({
        activeChatId:
          optimisticStart && state.activeChatId === optimisticStart.id
            ? initialChatId
            : state.activeChatId,
        navigation: optimisticStart
          ? navigationWithoutOptimisticSession(state.navigation, optimisticStart.id)
          : state.navigation,
        messages: state.messages.filter(
          (message) => message.id !== clientMessageId,
        ),
        summary:
          optimisticStart && state.summary?.session_id === optimisticStart.id
            ? null
            : state.summary,
        optimisticSessionStart:
          optimisticStart &&
          state.optimisticSessionStart?.id === optimisticStart.id
            ? null
            : state.optimisticSessionStart,
      }));
      notifyError(error, "Message send failed", {
        id: `send-message-${targetChatId}`,
      });
      set({ status: { label: "ready", tone: "ok" } });
    } finally {
      set((state) => {
        return {
          ...completedSendingOperationState(state, sendOperationId),
        };
      });
    }
  },

  cancelActiveTurn: async () => {
    const { activeChatId, sessionView } = get();
    const activeTurn =
      sessionView?.session_id === activeChatId ? sessionView.active_turn : null;
    const turnId = activeTurn?.id;
    if (
      !turnId ||
      !activeTurn.cancellable ||
      !ACTIVE_TURN_STATES.has(activeTurn.state)
    ) {
      return;
    }
    set({ status: { label: "stopping", tone: "muted" } });
    try {
      await api(`/turns/${encodeURIComponent(turnId)}/cancel`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      await get().reloadMessages(activeChatId);
      await get().refreshSessionSummary(activeChatId);
      await get().refreshSessionView(activeChatId);
      set({ status: { label: "ready", tone: "ok" } });
    } catch (error) {
      notifyError(error, "Stop failed", { id: "turn-stop" });
      set({ status: { label: "ready", tone: "ok" } });
    }
  },

  createScratchProject: async () => {
    set({
      creatingProject: true,
      status: { label: "creating project", tone: "muted" },
    });
    try {
      const result = await api<{ project: ProjectSummary }>("/projects", {
        method: "POST",
        body: JSON.stringify({ source: "scratch" }),
      });
      await get().refreshNavigation();
      get().openNewProjectChat(result.project.id);
      set({ messages: [], status: { label: "ready", tone: "ok" } });
    } catch (error) {
      notifyError(error, "Project creation failed", { id: "project-create" });
      set({ status: { label: "ready", tone: "ok" } });
    } finally {
      set({ creatingProject: false });
    }
  },

  createProjectFromExistingFolder: async () => {
    if (!canSelectProjectFolder()) {
      notifyError(
        new Error(
          "Project folder picker is only available in the desktop app.",
        ),
        "Project folder failed",
        {
          id: "project-folder-picker-unavailable",
        },
      );
      set({ status: { label: "ready", tone: "ok" } });
      return;
    }
    set({
      creatingProject: true,
      status: { label: "choosing folder", tone: "muted" },
    });
    try {
      const selection = await selectProjectFolder();
      if (selection?.cancelled) {
        set({ status: { label: "ready", tone: "ok" } });
        return;
      }
      const result = await api<{ project: ProjectSummary }>("/projects", {
        method: "POST",
        body: JSON.stringify({
          source: "existing_folder",
          display_name: selection.display_name,
          folder_selection_token: selection.folder_selection_token,
        }),
      });
      await get().refreshNavigation();
      get().openNewProjectChat(result.project.id);
      set({ messages: [], status: { label: "ready", tone: "ok" } });
    } catch (error) {
      if (isProjectFolderPickerUnavailable(error)) {
        set({ status: { label: "ready", tone: "ok" } });
        return;
      }
      notifyError(error, "Project folder failed", { id: "project-folder" });
      set({ status: { label: "ready", tone: "ok" } });
    } finally {
      set({ creatingProject: false });
    }
  },

  runProjectAction: async (project, action) => {
    try {
      if (action === "rename") {
        set({ renameProject: project });
      } else if (action === "pin") {
        await api(`/projects/${encodeURIComponent(project.id)}/pin`, {
          method: "POST",
          body: JSON.stringify({ pinned: !project.pinned }),
        });
      } else if (action === "archive") {
        await api(`/projects/${encodeURIComponent(project.id)}/archive`, {
          method: "POST",
          body: JSON.stringify({}),
        });
      } else if (action === "delete") {
        if (
          !window.confirm(
            appCopy.sidebar.projectDeleteConfirm(project.display_name),
          )
        )
          return;
        await api(
          `/projects/${encodeURIComponent(project.id)}?permanent=true`,
          {
            method: "DELETE",
          },
        );
      }
      await get().refreshNavigation();
    } catch (error) {
      notifyError(error, "Project action failed", {
        id: `project-action-${project.id}`,
      });
      set({ status: { label: "ready", tone: "ok" } });
    }
  },

  runSessionAction: async (session, action) => {
    try {
      if (action === "rename") {
        set({ renameSession: session });
      } else if (action === "archive") {
        await api(`/sessions/${encodeURIComponent(session.id)}/archive`, {
          method: "POST",
          body: JSON.stringify({}),
        });
        await get().refreshNavigation();
        if (get().activeChatId === session.id) get().openNewChat();
      }
    } catch (error) {
      notifyError(error, "Session action failed", {
        id: `session-action-${session.id}`,
      });
      set({ status: { label: "ready", tone: "ok" } });
    }
  },

  submitProjectRename: async (project, displayName) => {
    const nextName = displayName.trim();
    if (!nextName) return;
    try {
      await api(`/projects/${encodeURIComponent(project.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ display_name: nextName }),
      });
      await get().refreshNavigation();
      set({
        renameProject: null,
        status: { label: "project renamed", tone: "ok" },
      });
    } catch (error) {
      notifyError(error, "Rename failed", {
        id: `project-rename-${project.id}`,
      });
      set({ status: { label: "ready", tone: "ok" } });
    }
  },

  submitSessionRename: async (session, title) => {
    const nextTitle = title.trim();
    if (!nextTitle) return;
    try {
      await api(`/sessions/${encodeURIComponent(session.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ title: nextTitle }),
      });
      await get().refreshNavigation();
      set({
        renameSession: null,
        status: { label: "session renamed", tone: "ok" },
      });
    } catch (error) {
      notifyError(error, "Rename failed", {
        id: `session-rename-${session.id}`,
      });
      set({ status: { label: "ready", tone: "ok" } });
    }
  },

  retryTurn: async (turnId) => {
    set({
      retryingTurnId: turnId,
      status: { label: "retrying", tone: "muted" },
    });
    try {
      const result = await api<{
        replies?: MessageRecord[];
        reply?: MessageRecord;
      }>(`/turns/${encodeURIComponent(turnId)}/retry`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      set((state) => ({
        messages: mergeMessages(
          state.messages.filter(
            (message) =>
              message.turn_id !== turnId || message.role !== "assistant",
          ),
          result.replies ?? (result.reply ? [result.reply] : []),
        ),
      }));
      await get().reloadMessages(get().activeChatId);
      await get().refreshNavigation();
      await get().refreshSessionSummary(get().activeChatId);
      set({ status: { label: "ready", tone: "ok" } });
    } catch (error) {
      await get().reloadMessages(get().activeChatId);
      notifyError(error, "Retry failed", { id: `turn-retry-${turnId}` });
      set({ status: { label: "ready", tone: "ok" } });
    } finally {
      set({ retryingTurnId: null });
    }
  },

  controlWorker: async (workerId, action) => {
    try {
      const result = await api<{ notice?: MessageRecord }>(
        `/worker-activity/${encodeURIComponent(workerId)}/control`,
        {
          method: "POST",
          body: JSON.stringify({ action }),
        },
      );
      if (result.notice?.chat_id === get().activeChatId) {
        set((state) => ({
          messages: result.notice
            ? mergeMessages(state.messages, [result.notice])
            : state.messages,
        }));
      }
      await get().refreshSessionSummary(get().activeChatId);
    } catch (error) {
      notifyError(error, "Worker control failed", {
        id: `worker-control-${workerId}`,
      });
      set({ status: { label: "ready", tone: "ok" } });
    }
  },

  exportTranscript: async () => {
    try {
      const exported = await api<{ content: string; filename: string }>(
        `/transcript-export?session_id=${encodeURIComponent(get().activeChatId)}`,
      );
      const blob = new Blob([exported.content], {
        type: "text/markdown;charset=utf-8",
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = exported.filename;
      link.click();
      URL.revokeObjectURL(url);
      set({ status: { label: "transcript exported", tone: "ok" } });
    } catch (error) {
      notifyError(error, "Export failed", { id: "transcript-export" });
      set({ status: { label: "ready", tone: "ok" } });
    }
  },

  navigateCommandResult: (result) => {
    if (result.route.startsWith("session:")) {
      get().openSession(result.route.slice("session:".length));
    } else if (result.route.startsWith("project:")) {
      get().openNewProjectChat(result.route.slice("project:".length));
    } else if (result.route.startsWith("automation:")) {
      set({
        view: {
          kind: "automation-detail",
          automationId: result.route.slice("automation:".length),
        },
      });
    } else if (result.route.startsWith("settings:")) {
      get().openSettings(result.route.slice("settings:".length));
    }
    set({ commandOpen: false });
  },
}));

export const selectActiveChat = (state: ButlerStore) =>
  activeChatFromNavigation(state.navigation, state.activeChatId);
export const selectActiveSessionView = (state: ButlerStore) =>
  state.view.kind === "session";
export const selectRightAvailable = (state: ButlerStore) =>
  selectActiveSessionView(state) && isServerBackedSessionId(state.activeChatId);
export const selectEffectiveRightOpen = (state: ButlerStore) =>
  state.rightOpen && selectRightAvailable(state);
export const selectViewTitle = (state: ButlerStore) =>
  activeTitleForView(state.view, selectActiveChat(state));
export const selectIsSettingsView = (state: ButlerStore) =>
  state.view.kind === "settings";
