import { Database } from "bun:sqlite";
import {
  accessSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import {
  PERSONALIZATION_PROFILE_STORAGE_LABEL,
  readPersonalizationProfile,
  updatePersonalizationProfile,
} from "../../personalization/profile.ts";
import {
  clearProfilingData,
  importProfileCandidatesFromThirdPartyDumpWithModel,
  PROFILE_BLACK_BOX_STORAGE_LABEL,
  PROFILE_EXTRACTOR_MODEL_DEFAULT,
  readProfilingExtractorModelConfig,
  readProfilingConsentSnapshot,
  setProfilingExtractorModel,
  setProfilingExtractorReasoningEffort,
  setProfilingMode,
} from "../../personalization/profiling.ts";
import { readPersonaPresets } from "../../personalization/persona-presets.ts";
import { TaskStore } from "../../agent/work/task-store.ts";
import {
  applyTurnLocalWorkOutcomeForSession,
  workStreamTerminal,
  WorkStreamStore,
} from "../../agent/work/work-stream.ts";
import {
  TURN_ACKNOWLEDGED_EVENT_KIND,
  createTurnAcknowledgedPayload,
} from "../../agent/events/turn-state-contract.ts";
import { FIRST_VISIBLE_PROGRESS_EVENT_KIND } from "../../agent/events/turn-events.ts";
import { ensureAppMessageQuerySchema } from "../../agent/cognition/memory/exact-query.ts";
import {
  PlannedTaskStore,
  type PlannedTaskRecord,
} from "../../agent/work/planned-task.ts";
import {
  WorkOrchestrationStore,
  type WorkOrchestrationRecord,
} from "../../agent/work/work-orchestration.ts";
import {
  DEFAULT_MODEL_REF,
  DEFAULT_REASONING_EFFORT,
  localModelConfigToMetadata,
  modelCatalogView,
  resolveModelMetadata,
  resolveRegisteredRuntimeModelMetadata,
  type ModelCatalogView,
  type ProviderModelMetadata,
} from "../../integrations/providers/model-catalog.ts";
import {
  deleteLocalModelConfig,
  discoverLocalModels,
  readLocalModelConfigs,
  updateLocalModelConfig,
  upsertLocalModelConfig,
} from "../../integrations/providers/local-models.ts";
import {
  credentialView,
  deleteHostedModelConfig,
  listProviderCredentialViews,
  registerHostedModelConfig,
  registeredHostedModelMetadata,
  upsertProviderApiKeyCredential,
  type HostedModelProviderId,
} from "../../integrations/providers/registered-models.ts";
import {
  getNativeMainStatePath,
  readNativeMainState,
} from "../../integrations/providers/native-main-state.ts";
import {
  isPidRunning,
  readServiceState,
} from "../../operations/service/native-service-supervisor.ts";
import {
  estimateContextTokensForModel,
  evaluateWorkingContextBudget,
  resolveContextBudgetConfig,
  WORKING_CONTEXT_AUTO_COMPACT_RATIO,
  WORKING_CONTEXT_HARD_PRESSURE_RATIO,
} from "../../agent/context/budget.ts";
import { readCompactionSnapshots } from "../../agent/context/compaction.ts";
import {
  APP_PROTOCOL_VERSION,
  type AppEventEnvelope,
  type AppInfoView,
  type AutomationDetailView,
  type AutomationListView,
  type AutomationMutationResult,
  type AutomationRunListView,
  type AutomationRunResult,
  type AutomationRunSummary,
  type AutomationRunState,
  type AutomationState,
  type AutomationTargetSummary,
  type ArchiveListView,
  type ChatKind,
  type ChatSummary,
  type CommandPaletteView,
  type ContextDetailsView,
  type CreateAutomationRequest,
  type CreateProjectRequest,
  type CreateProjectResult,
  type CreateSessionRequest,
  type CreateSessionResult,
  type HostedModelDeletionResult,
  type HostedModelRegistrationRequest,
  type HostedModelRegistrationResult,
  type MessageRecord,
  type MessageFileKind,
  type MessageFileRef,
  type MessageFileUploadResult,
  type MessageRole,
  type MessageSendRequest,
  type MessageSendResult,
  type MessageStatus,
  type McpCapabilitiesView,
  type McpServerDeleteResult,
  type McpServerListView,
  type McpServerMutationResult,
  type McpServerUpsertRequest,
  type NewChatBriefingView,
  type PersonalizationView,
  type PersonalizationProfileMigrationRequest,
  type PersonalizationProfileMigrationResultView,
  type ProviderCredentialMutationResult,
  type ProviderCredentialUpsertRequest,
  type ProjectDashboardView,
  type LocalModelDiscoveryRequest,
  type LocalModelDiscoveryResult,
  type LocalModelDeletionResult,
  type LocalModelRegistrationRequest,
  type LocalModelRegistrationResult,
  type LocalModelUpdateRequest,
  type NavigationView,
  type ProjectListView,
  type ProjectActionResult,
  type ProjectSessionListView,
  type ProjectSummary,
  type ProgressSummaryRow,
  type QueueMessageRequest,
  type QueuedMessageRecord,
  type SessionArtifactSummary,
  type SessionControlState,
  type SessionControlsView,
  type SessionListView,
  type SessionActionResult,
  type SessionQueueView,
  type SessionSummaryView,
  type SessionView,
  type SessionViewTurn,
  type SettingsView,
  type SkillImportResult,
  type SkillSettingsView,
  type SystemEventListView,
  type TranscriptExportView,
  type UsageMonitorView,
  type SessionSummary,
  type TurnActionResult,
  type TurnRecord,
  type TurnProgressSnapshotView,
  type TurnState,
  type UpdateApplyRequest,
  type UpdateApplyResult,
  type UpdateAutomationRequest,
  type UpdateCheckRequest,
  type UpdatePersonalizationRequest,
  type UpdateProjectRequest,
  type UpdateQueuedMessageRequest,
  type UpdateSessionRequest,
  type UpdateSettingsRequest,
  type UpdateStatusView,
  type WorkerActivityControlRequest,
  type WorkerActivityControlResult,
  type WorkerActivityListView,
  type WorkerActivitySummary,
} from "./protocol.ts";
import { buildNewChatBriefing } from "./new-chat-briefing.ts";
import { loadProjectDocumentCatalog } from "./project-document-catalog.ts";
import { isPathInside, isSensitiveProjectFolder } from "./path-safety.ts";
import {
  readConfigDefaultModel,
  readConfigUserSettings,
  writeConfigUserSettings,
  type ConfigUserSettings,
} from "./settings-config.ts";
import {
  normalizeDesktopNotificationSettings,
  normalizedMainScreenThemeColorsOrDefault,
  normalizedMainScreenThemeOrDefault,
  normalizedMainScreenThemePresetOrDefault,
  normalizedMultilineSendBehaviorOrDefault,
  normalizeTimezone,
  sanitizeSettingsUpdate,
} from "./settings-preferences.ts";
import {
  clampContextWindowTokens,
  contextWindowTokensForSessionModel,
  normalizeSessionControls,
  normalizeWorkerModelRules,
  rewriteSettingsModelRefs,
} from "./settings-models.ts";
import {
  normalizeWebSearchSettings,
  readConfigWebSearchSettings,
  webSearchSettingsPatchFrom,
  writeConfigWebSearchSettings,
  writeWebSearchProviderApiKey,
} from "./web-search-settings.ts";
import {
  shouldKeepInactiveLinkedReportingWorker,
} from "./worker-activity-projection.ts";
import {
  appWorkStreamVisibleInActiveProjection,
  isActiveWorkerActivity,
  orderWorkerActivities,
  relabelWorkerActivities,
  synthesizeOrchestrationParentActivities,
  workerActivityFromTaskSummary,
} from "./worker-activity-read-model.ts";
import {
  isNoSuchProcessError,
  parsePositiveInteger,
  readTextFile,
  workerTaskIdsForPlannedTask,
  writeWorkerActivityProjection,
} from "./worker-task-files.ts";
import {
  chatFromRow,
  isActiveSessionTurnState,
  maxMessageCursor,
  paginationInput,
  projectFromRow,
  safeDisplayName,
  safeLocalSessionId,
  safeWorkspaceLabel,
  sessionFromRow,
  sessionHintForRow,
  sessionViewStatus,
} from "./session-read-model.ts";
import { systemEventsForButlerData } from "./system-events-read-model.ts";
import {
  automationDetailFromRow,
  automationRunFromRow,
  automationSummaryFromRow,
  automationSummaryWithoutPrompt,
  normalizeAutomationInterval,
} from "./automation-read-model.ts";
import {
  turnLocalWorkOutcomeForAppTurn,
  turnLocalWorkOutcomeStatusNote,
} from "./turn-local-work-outcome.ts";
import {
  isRecord,
  safeInboundQueueId,
  safeOptionalShortText,
  safeOptionalShortToken,
  safeParseRecord,
} from "./projection-safe-values.ts";
import { workBlocksFromTerminalProgressRows } from "./session-work-blocks.ts";
import { publicAppEventPayload } from "./public-app-event-payload.ts";
import {
  readTranscriptEventsFromText,
  readTranscriptFromDataHome,
  readTranscriptTextRange,
  transcriptPathFromDataHome,
} from "./transcript-reader.ts";
import {
  artifactCandidatePaths,
  artifactRefsFromOutboundMessage,
  progressRowFromAppOutbound,
  sanitizeAppTransportFinalText,
} from "./app-transport-projection.ts";
import {
  classifyMessageFileKind,
  MESSAGE_FILE_ID_PATTERN,
  MESSAGE_FILE_MAX_ATTACHMENTS,
  MESSAGE_FILE_MAX_BYTES,
  messageFileContentKey,
  mimeTypeForArtifactPath,
  normalizeAttachmentMimeType,
  normalizeFileBytes,
  safeAttachmentName,
} from "./message-file-storage.ts";
import {
  backupPrivatePersonalizationFile,
  boundedPrivateText,
  readPrivateText,
  startOfUtcDay,
} from "./personalization-file-storage.ts";
import { appRuntimePolicy, stringArray } from "./app-runtime-policy.ts";
export { appRuntimePolicy } from "./app-runtime-policy.ts";
import {
  contextCategory,
  latestLivePromptUsage,
} from "./context-details-read-model.ts";
import {
  isTerminalTurnState,
  messageFileRefFromRow,
  messageFromRow,
  turnFromRow,
} from "./message-read-model.ts";
import {
  appLimitedDeliveryForProjectedFailure,
  deliveryLimitationMetadataFromRecord,
  deliveryStateFromProjectedNoVisibleFinal,
  hasUnsupportedNoVisibleDeliveryState,
  shouldAcceptRecoverableLimitedFinalForFailedQueue,
  shouldProjectRecoverableLimitedFinalOverTerminalTurn,
  shouldTreatLimitedFinalAsNoVisible,
  terminalClaimId,
  type DeliveryLimitationMetadata,
} from "./app-delivery-projection.ts";
export type { DeliveryLimitationMetadata } from "./app-delivery-projection.ts";
import {
  isAppWorkerResultOutbound,
  isInternalContinuationTurnState,
  loadedSkillNamesFromTranscriptEvent,
  mergeTransportBindings,
  normalizeAppModelRef,
  normalizeGeneratedSessionTitle,
  provisionalSessionTitleFromPrompt,
  runtimeTurnEventFromAppOutboundMetadata,
  timestampBefore,
} from "./app-transport-metadata.ts";
import {
  AppResponderCancelledError,
  AppResponderTimeoutError,
  AppStoreOperationError,
} from "./app-store-errors.ts";
export {
  AppResponderCancelledError,
  AppResponderTimeoutError,
  AppStoreOperationError,
} from "./app-store-errors.ts";
import { readProjectFolderSelectionToken } from "./project-folder-selection-token.ts";
export { createProjectFolderSelectionToken } from "./project-folder-selection-token.ts";
import {
  createAgentTurnEvent,
  progressRowFromTurnEvent,
  turnEventFromProgressRow,
  type AgentTurnEvent,
  type RuntimeTurnEventInput,
} from "../../agent/events/turn-events.ts";
import { INTERNAL_RECOVERY_REQUIRED_CODE } from "../../runtime/internal-recovery-failure.ts";
import { SessionBindingStore } from "../../test-support/harness/session-store.ts";
import type { SessionTransportBinding } from "../../test-support/harness/contracts.ts";
import type { TranscriptEvent } from "../../test-support/harness/transcripts.ts";
import type { ArtifactRef, AttachmentRef } from "../core/contracts.ts";
import {
  type ButlerServiceClient,
  FileQueueButlerServiceClient,
} from "../core/client.ts";
import {
  APP_ACCOUNT,
  APP_SENDER_ID,
  APP_TRANSPORT,
} from "../core/app-transport.ts";
import {
  appLimitedDeliveryForError,
  appSafeResponderError,
  isNonPublicContinuationDeliveryError,
  type AppLimitedDelivery,
} from "./failure-ux-contract.ts";
import {
  isInternalContinuationProgressEvent,
  isTerminalProgressState,
  normalizeProgressSummaryRow,
  progressRowsEquivalent,
  progressRowsForTurnState,
  progressSummaryStatusLabel,
  publicProgressRowsForTurn,
  type ProgressSummaryInput,
} from "./progress-summary.ts";
import {
  isContinuationDeliveryIssue,
  shouldAutomaticallyRequeueContinuation,
} from "./continuation-delivery.ts";
import {
  APP_TURN_QUEUE_FAILED_CODE,
  HIDDEN_LEGACY_ASSISTANT_SAFE_ERROR_CODES,
  isPublicSuppressedInternalContinuationCode,
  publicAppDeliveryMetadata,
  publicDeliveryMetadataForProjection,
  publicDeliveryStateForProjection,
  publicDeliveryStateForTurnState,
  publicTurnRecord,
  publicTurnStatusLabel,
} from "./btcc-public-projection.ts";
import {
  CANCELLED_TURN_ACTIVITY_TEXT,
  isCancelledTurnActivityCarrier,
} from "./cancelled-turn-activity.ts";
import {
  completeResponderTurn as completeResponderTurnLifecycle,
  isResponderCancelError,
} from "./responder-turn-lifecycle.ts";
import {
  projectSafeTurnFailure,
  safeTurnFailureEventPayload,
} from "./turn-failure-projection.ts";
import {
  applyComponentUpdate,
  checkComponentUpdates,
} from "../../operations/update/component-updater.ts";
import {
  deleteMcpServer,
  listMcpServers,
  updateMcpServer,
  upsertMcpServer,
} from "../../interfaces/mcp-client/registry.ts";
import {
  listMcpServerCapabilities,
  probeMcpServer,
} from "../../interfaces/mcp-client/client.ts";
import {
  importSkillZip,
  skillSettingsView,
} from "../../integrations/skills/manager.ts";
import { readUsageMonitor } from "../../operations/metrics/usage-monitor.ts";

const DEFAULT_CHAT_ID = "general";
const DEFAULT_PROJECT_ID = "butler";
const DEFAULT_CHAT_TITLE = "Onboarding";
const SCRATCH_PROJECT_BASE_NAME = "New project";
const DEFAULT_PROJECT_WORKSPACE_SETTING_KEY = "default-project-workspace-root";
const APP_REPOSITORY_URL = "https://github.com/Hexpy-Games/butler";
function visibleMessageSqlPredicate(alias?: string): string {
  const prefix = alias ? `${alias}.` : "";
  const codes = HIDDEN_LEGACY_ASSISTANT_SAFE_ERROR_CODES.map(
    (code) => `'${code}'`,
  ).join(", ");
  return `NOT (${prefix}role = 'assistant' AND ${prefix}safe_error_code IS NOT NULL AND ${prefix}safe_error_code IN (${codes}))`;
}

type CapturedUserFeedback = {
  entry: {
    feedback_id: string;
    category: string;
    scope: string;
    target_ref?: string | null;
  };
  reason: string;
};

function captureUserFeedbackFromMessage(
  _input: unknown,
): CapturedUserFeedback | null {
  return null;
}

interface ChatRow {
  id: string;
  title: string;
  kind: ChatKind;
  project_id: string | null;
  created_at: string;
  updated_at: string;
}

interface ProjectRow {
  id: string;
  display_name: string;
  status: "active" | "archived";
  workspace_path: string;
  workspace_label: string;
  safe_path_label: string;
  pinned: number;
  archived: number;
  error_summary: string | null;
  created_at: string;
  updated_at: string;
}

interface SessionSummaryRow {
  id: string;
  kind: ChatKind;
  title: string;
  project_id: string | null;
  project_display_name?: string | null;
  created_at: string;
  updated_at: string;
  last_message_preview: string | null;
  active_turn_state: TurnState | null;
  safe_status_label: string | null;
  active_turn_safe_error_code: string | null;
  pinned: number;
  archived: number;
}

interface MessageRow {
  rowid: number;
  id: string;
  chat_id: string;
  turn_id: string | null;
  role: MessageRole;
  text: string;
  status: MessageStatus;
  created_at: string;
  updated_at: string;
  safe_error_code: string | null;
  retryable: number;
}

interface MessageFileRow {
  id: string;
  owner_session_id: string | null;
  message_id: string | null;
  kind: MessageFileKind;
  mime_type: string;
  safe_name: string;
  size_bytes: number;
  sha256: string;
  storage_name: string;
  created_at: string;
}

interface QueuedMessageRow {
  rowid: number;
  id: string;
  chat_id: string;
  text: string;
  controls_json: string;
  attachments_json: string;
  state: QueuedMessageRecord["state"];
  safe_error_code: string | null;
  dispatched_message_id: string | null;
  turn_id: string | null;
  created_at: string;
  updated_at: string;
}

interface EventRow {
  id: number;
  type: string;
  payload_json: string;
  created_at: string;
}

interface TurnRow {
  rowid: number;
  id: string;
  chat_id: string;
  user_message_id: string | null;
  state: TurnState;
  safe_status_label: string;
  safe_error_code: string | null;
  retryable: number;
  cancellable: number;
  attempt: number;
  created_at: string;
  updated_at: string;
}

interface SettingRow {
  key: string;
  value_json: string;
}

interface AutomationRow {
  id: string;
  title: string;
  prompt_body: string;
  target_kind: ChatKind;
  target_session_id: string;
  interval_seconds: number;
  state: AutomationState;
  next_run_at: string | null;
  last_run_at: string | null;
  last_run_state: AutomationRunState;
  last_safe_error_code: string | null;
  run_count: number;
  consecutive_failure_count: number;
  created_at: string;
  updated_at: string;
}

interface AutomationRunRow {
  rowid: number;
  id: string;
  automation_id: string;
  target_session_id: string;
  state: AutomationRunState;
  trigger: "scheduled" | "run_now";
  started_at: string;
  completed_at: string | null;
  safe_error_code: string | null;
  queued_message_id: string | null;
  turn_id: string | null;
}

interface QueuedAutomationRunRow {
  run_id: string;
  automation_id: string;
  target_session_id: string;
  trigger: "scheduled" | "run_now";
  queued_message_id: string | null;
  title: string;
  prompt_body: string;
  target_kind: ChatKind;
  interval_seconds: number;
  state: AutomationState;
  next_run_at: string | null;
  last_run_at: string | null;
  last_run_state: AutomationRunState;
  last_safe_error_code: string | null;
  run_count: number;
  consecutive_failure_count: number;
  created_at: string;
  updated_at: string;
}

export interface AppServerStoreOptions {
  dbPath?: string;
  projectWorkspaceRoot?: string;
  folderSelectionSecret?: string;
  butlerData?: string;
  butlerHome?: string;
  appVersion?: string;
  appUpdateManifest?: string;
  serverUrl?: string;
  bridgeMode?: SettingsView["bridge_mode"];
  serviceClient?: ButlerServiceClient;
}

export interface AppMessageResponderInput {
  chatId: string;
  turnId: string;
  messageId: string;
  text: string;
  attachments?: MessageFileRef[];
  sessionKind: ChatKind;
  projectId?: string;
  projectWorkspacePath?: string;
  model?: string;
  reasoningEffort?: SettingsView["reasoning_effort"];
  workerModelRules?: SettingsView["worker_model_rules"];
  accessMode?: SettingsView["access_mode"];
  planMode?: boolean;
  onSessionTitle?: (title: string) => void;
  onProgress?: (row: ProgressSummaryInput) => void;
  onTurnEvent?: (event: RuntimeTurnEventInput) => void;
  signal?: AbortSignal;
}

export interface AppMessageResponderFile {
  name: string;
  mimeType: string;
  bytes: Uint8Array | ArrayBuffer | string;
}

export interface AppMessageResponderResult {
  texts: string[];
  files?: AppMessageResponderFile[];
  progress?: ProgressSummaryInput[];
  delivery?: DeliveryLimitationMetadata;
}

export type AppMessageResponder = (
  input: AppMessageResponderInput,
) => Promise<AppMessageResponderResult> | AppMessageResponderResult;

export interface SendMessageOptions {
  responderTimeoutMs?: number;
  controls?: SessionControlState;
  deferResponderTurns?: boolean;
  suppressAssistantReplies?: boolean;
}

interface TranscriptSyncSnapshot {
  path: string;
  size: number;
  mtimeMs: number;
  trailing: string;
}

interface PendingAppTurnEventOutbound {
  chatId: string;
  event: TranscriptEvent;
}

export class AppServerStore {
  private static readonly DEFAULT_APP_UPDATE_MANIFEST =
    "https://github.com/Hexpy-Games/butler/releases/latest/download/app-update-manifest.json";

  readonly db: Database;
  private closed = false;
  private projectWorkspaceRoot: string;
  private readonly folderSelectionSecret?: string;
  private readonly butlerData: string;
  private readonly butlerHome: string;
  private readonly appVersion?: string;
  private readonly appUpdateManifest: string;
  private readonly serverUrl: string;
  private readonly bridgeMode: SettingsView["bridge_mode"];
  private readonly serviceClient: ButlerServiceClient;
  private readonly sessionBindingStore: SessionBindingStore;
  private readonly eventSubscribers = new Set<
    (event: AppEventEnvelope) => void
  >();
  private readonly sessionTurnEventSequences = new Map<string, number>();
  private readonly turnEventSequences = new Map<string, number>();
  private readonly transcriptSyncSnapshots = new Map<
    string,
    TranscriptSyncSnapshot
  >();
  private readonly pendingAppTurnEventOutbounds = new Map<
    string,
    PendingAppTurnEventOutbound
  >();
  private readonly pendingSystemResponderTurns = new Set<string>();
  private readonly activeTurnControllers = new Map<string, AbortController>();

  constructor(options: AppServerStoreOptions = {}) {
    this.projectWorkspaceRoot = resolve(
      options.projectWorkspaceRoot ?? join(homedir(), "butler-workspace"),
    );
    this.folderSelectionSecret = options.folderSelectionSecret;
    this.butlerData = resolve(
      options.butlerData ??
        process.env.BUTLER_DATA ??
        join(homedir(), ".butler"),
    );
    this.butlerHome = resolve(
      options.butlerHome ?? process.env.BUTLER_HOME ?? process.cwd(),
    );
    this.appVersion = safeString(options.appVersion);
    this.appUpdateManifest =
      safeString(options.appUpdateManifest) ??
      safeString(process.env.BUTLER_APP_UPDATE_MANIFEST) ??
      safeString(process.env.BUTLER_UPDATE_MANIFEST) ??
      AppServerStore.DEFAULT_APP_UPDATE_MANIFEST;
    this.serverUrl = options.serverUrl ?? "http://127.0.0.1:18765";
    this.bridgeMode = options.bridgeMode ?? "local";
    this.serviceClient =
      options.serviceClient ??
      new FileQueueButlerServiceClient({ butlerData: this.butlerData });
    this.sessionBindingStore = new SessionBindingStore(
      join(this.butlerData, "runtime", "session-store.sqlite"),
    );
    this.db = new Database(options.dbPath ?? ":memory:", { create: true });
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA foreign_keys = ON");
    this.migrate();
    this.projectWorkspaceRoot =
      this.readStoredProjectWorkspaceRoot() ?? this.projectWorkspaceRoot;
    this.seedDefaults();
    this.reconcileCancelledTurnActivityMessages();
  }

  close(): void {
    if (this.closed) return;
    try {
      this.db.query("PRAGMA wal_checkpoint(TRUNCATE)").all();
    } finally {
      this.sessionBindingStore.close();
      this.db.close();
      this.closed = true;
    }
  }

  butlerDataRoot(): string {
    return this.butlerData;
  }

  async getUpdateStatus(): Promise<UpdateStatusView> {
    return await checkComponentUpdates({
      root: this.butlerHome,
      butlerData: this.butlerData,
      appVersion: this.appVersion,
      manifestPath: this.appUpdateManifest,
      components: ["app"],
    });
  }

  async checkUpdates(
    request: UpdateCheckRequest = {},
  ): Promise<UpdateStatusView> {
    const components =
      request.components ??
      (request.component ? [request.component] : undefined);
    return await checkComponentUpdates({
      root: this.butlerHome,
      butlerData: this.butlerData,
      appVersion: this.appVersion,
      manifestPath: this.appUpdateManifest,
      components,
      channel: request.channel,
    });
  }

  async applyUpdate(request: UpdateApplyRequest): Promise<UpdateApplyResult> {
    return await applyComponentUpdate({
      root: this.butlerHome,
      butlerData: this.butlerData,
      appVersion: this.appVersion,
      component: request.component,
      manifestPath: this.appUpdateManifest,
      channel: request.channel,
      dryRun: request.dry_run,
    });
  }

  getAppInfo(): AppInfoView {
    const pkg = safeObject(
      readJsonFile(
        join(
          this.butlerHome,
          "packages",
          "butler-app",
          "client",
          "electron",
          "package.json",
        ),
      ),
    );
    return {
      name: safeString(pkg.productName) || "Butler",
      version: safeString(pkg.version) || "0.0.0",
      repository_url: APP_REPOSITORY_URL,
      protocol_version: APP_PROTOCOL_VERSION,
      developer_mode_available: false,
      developer_mode_enabled: false,
    };
  }

  private localModelMetadata(): ProviderModelMetadata[] {
    return readLocalModelConfigs(this.butlerData).map(
      localModelConfigToMetadata,
    );
  }

  private registeredModelMetadata(): ProviderModelMetadata[] {
    return [
      ...registeredHostedModelMetadata(this.butlerData),
      ...this.localModelMetadata(),
    ];
  }

  listChats(): ChatSummary[] {
    const rows = this.db
      .query<ChatRow, []>(
        `
      SELECT id, title, kind, project_id, created_at, updated_at
      FROM chats
      WHERE archived = 0
      ORDER BY updated_at DESC, created_at DESC
    `,
      )
      .all();
    return rows.map(chatFromRow);
  }

  listNavigation(): NavigationView {
    const automations = this.listAutomations().automations;
    const settings = this.getSettings();
    return {
      chats: this.listSessions({ kind: "chat" }).sessions,
      projects: this.listProjects({ includeSessions: true }).projects,
      automations_summary: {
        total_count: automations.length,
        enabled_count: automations.filter(
          (automation) => automation.state === "enabled",
        ).length,
      },
      settings_summary: {
        profile_label: settings.profile_label,
      },
      generated_at: new Date().toISOString(),
    };
  }

  getNewChatBriefing(
    options: { date?: string | null; projectId?: string | null } = {},
  ): NewChatBriefingView {
    const settings = this.getSettings();
    const configUserSettings = readConfigUserSettings(this.butlerData);
    const projectId = options.projectId?.trim();
    const project = projectId ? this.getProjectRow(projectId) : null;
    if (projectId && !project) {
      throw new AppStoreOperationError(
        404,
        "project_not_found",
        "Project not found.",
      );
    }
    const projectDocumentCatalog = project
      ? loadProjectDocumentCatalog({
          butlerDataRoot: this.butlerData,
          project,
        })
      : null;
    return buildNewChatBriefing({
      butlerData: this.butlerData,
      preferredLocale: configUserSettings.responseLanguage ??
        (settings.language === "ko" ? "ko" : "en"),
      date: options.date,
      project: project
        ? {
            id: project.id,
            displayName: project.display_name,
            documents: projectDocumentCatalog?.briefingDocuments,
          }
        : undefined,
    });
  }

  listProjects(options: { includeSessions?: boolean } = {}): ProjectListView {
    const rows = this.db
      .query<ProjectRow, []>(
        `
      SELECT id, display_name, status, workspace_path, workspace_label, safe_path_label,
        pinned, archived, error_summary, created_at, updated_at
      FROM projects
      WHERE archived = 0
      ORDER BY pinned DESC, updated_at DESC, display_name ASC
    `,
      )
      .all();
    const sessions = options.includeSessions
      ? this.listProjectSessions().sessions
      : [];
    const sessionsByProject = new Map<string, SessionSummary[]>();
    for (const session of sessions) {
      if (!session.project_id) continue;
      const bucket = sessionsByProject.get(session.project_id) ?? [];
      bucket.push(session);
      sessionsByProject.set(session.project_id, bucket);
    }
    return {
      projects: rows.map((row) =>
        projectFromRow(
          row,
          options.includeSessions
            ? (sessionsByProject.get(row.id) ?? [])
            : undefined,
        ),
      ),
    };
  }

  createProject(input: CreateProjectRequest): CreateProjectResult {
    let workspacePath: string;
    if (input.source === "scratch") {
      workspacePath = this.createScratchProjectFolder();
    } else {
      if (!input.folder_selection_token?.trim()) {
        throw new AppStoreOperationError(
          400,
          "folder_selection_required",
          "Project folder selection is required.",
        );
      }
      workspacePath = readProjectFolderSelectionToken(
        input.folder_selection_token,
        this.folderSelectionSecret,
      );
      workspacePath = this.validateProjectFolder(workspacePath);
    }

    const existing = this.getProjectRowByWorkspacePath(workspacePath);
    if (existing) return { project: projectFromRow(existing) };

    const now = new Date().toISOString();
    const workspaceLabel = safeWorkspaceLabel(workspacePath);
    const displayName = safeDisplayName(input.display_name, workspaceLabel);
    const projectId = this.nextProjectId(displayName);
    this.db
      .query(
        `
      INSERT INTO projects (
        id, display_name, status, workspace_path, workspace_label, safe_path_label,
        pinned, archived, error_summary, created_at, updated_at
      )
      VALUES (?, ?, 'active', ?, ?, ?, 0, 0, NULL, ?, ?)
    `,
      )
      .run(
        projectId,
        displayName,
        workspacePath,
        workspaceLabel,
        workspaceLabel,
        now,
        now,
      );
    const row = this.getProjectRow(projectId);
    if (!row) throw new Error(`Failed to create project: ${projectId}`);
    const project = projectFromRow(row);
    this.appendEvent("project.created", { project });
    return { project };
  }

  updateProject(
    projectId: string,
    input: UpdateProjectRequest,
  ): ProjectActionResult {
    const row = this.getProjectRowAnyStatus(projectId);
    if (!row)
      throw new AppStoreOperationError(
        404,
        "project_not_found",
        "Project not found.",
      );
    const displayName = input.display_name?.trim();
    const now = new Date().toISOString();
    this.db
      .query(
        `
      UPDATE projects
      SET display_name = ?, pinned = ?, archived = ?, status = ?, updated_at = ?
      WHERE id = ?
    `,
      )
      .run(
        displayName || row.display_name,
        input.pinned === undefined ? row.pinned : input.pinned ? 1 : 0,
        input.archived === undefined ? row.archived : input.archived ? 1 : 0,
        input.archived === undefined
          ? row.status
          : input.archived
            ? "archived"
            : "active",
        now,
        projectId,
      );
    const project = projectFromRow(this.getProjectRowAnyStatus(projectId)!);
    this.appendEvent("project.updated", { project });
    return { project };
  }

  archiveProject(projectId: string): ProjectActionResult {
    const result = this.updateProject(projectId, { archived: true });
    this.db
      .query(
        `
      UPDATE chats
      SET archived = 1, updated_at = ?
      WHERE project_id = ?
    `,
      )
      .run(new Date().toISOString(), projectId);
    return result;
  }

  pinProject(projectId: string, pinned?: boolean): ProjectActionResult {
    const row = this.getProjectRow(projectId);
    if (!row)
      throw new AppStoreOperationError(
        404,
        "project_not_found",
        "Project not found.",
      );
    return this.updateProject(projectId, {
      pinned: pinned ?? row.pinned !== 1,
    });
  }

  deleteProject(projectId: string): ProjectActionResult {
    const result = this.archiveProject(projectId);
    this.appendEvent("project.deleted", { project: result.project });
    return result;
  }

  deleteProjectPermanent(projectId: string): ProjectActionResult {
    const row = this.getProjectRowAnyStatus(projectId);
    if (!row)
      throw new AppStoreOperationError(
        404,
        "project_not_found",
        "Project not found.",
      );
    const project = projectFromRow(row);
    this.db.transaction(() => {
      this.db.query("DELETE FROM chats WHERE project_id = ?").run(projectId);
      this.db.query("DELETE FROM projects WHERE id = ?").run(projectId);
    })();
    this.appendEvent("project.permanently_deleted", { project });
    return { project };
  }

  listSessions(
    options: { kind?: ChatKind; projectId?: string } = {},
  ): SessionListView {
    const clauses = ["c.archived = 0"];
    const params: string[] = [];
    if (options.kind) {
      clauses.push("c.kind = ?");
      params.push(options.kind);
    }
    if (options.projectId) {
      clauses.push("c.project_id = ?");
      params.push(options.projectId);
    }
    const rows = this.db
      .query<SessionSummaryRow, string[]>(
        `
      SELECT
        c.id,
        c.kind,
        c.title,
        c.project_id,
        c.created_at,
        c.updated_at,
        (
          SELECT m.text
          FROM messages m
          WHERE m.chat_id = c.id
            AND ${visibleMessageSqlPredicate("m")}
          ORDER BY m.rowid DESC
          LIMIT 1
        ) AS last_message_preview,
        (
          SELECT t.state
          FROM turns t
          WHERE t.chat_id = c.id
          ORDER BY t.rowid DESC
          LIMIT 1
        ) AS active_turn_state,
        (
          SELECT t.safe_status_label
          FROM turns t
          WHERE t.chat_id = c.id
          ORDER BY t.rowid DESC
          LIMIT 1
        ) AS safe_status_label,
        (
          SELECT t.safe_error_code
          FROM turns t
          WHERE t.chat_id = c.id
          ORDER BY t.rowid DESC
          LIMIT 1
        ) AS active_turn_safe_error_code,
        c.pinned,
        c.archived
      FROM chats c
      WHERE ${clauses.join(" AND ")}
      ORDER BY c.pinned DESC, c.updated_at DESC, c.created_at DESC
      LIMIT 200
    `,
      )
      .all(...params);
    return {
      sessions: rows.map(sessionFromRow),
    };
  }

  listArchives(
    options: { limit?: number; offset?: number } = {},
  ): ArchiveListView {
    const page = paginationInput(options);
    const projectRows = this.db
      .query<ProjectRow, []>(
        `
      SELECT id, display_name, status, workspace_path, workspace_label, safe_path_label,
        pinned, archived, error_summary, created_at, updated_at
      FROM projects
      WHERE archived = 1
      ORDER BY updated_at DESC, created_at DESC
    `,
      )
      .all();
    const sessionRows = this.db
      .query<SessionSummaryRow, []>(
        `
      SELECT
        c.id,
        c.kind,
        c.title,
        c.project_id,
        p.display_name AS project_display_name,
        c.created_at,
        c.updated_at,
        (
          SELECT m.text
          FROM messages m
          WHERE m.chat_id = c.id
            AND ${visibleMessageSqlPredicate("m")}
          ORDER BY m.rowid DESC
          LIMIT 1
        ) AS last_message_preview,
        (
          SELECT t.state
          FROM turns t
          WHERE t.chat_id = c.id
          ORDER BY t.rowid DESC
          LIMIT 1
        ) AS active_turn_state,
        (
          SELECT t.safe_status_label
          FROM turns t
          WHERE t.chat_id = c.id
          ORDER BY t.rowid DESC
          LIMIT 1
        ) AS safe_status_label,
        (
          SELECT t.safe_error_code
          FROM turns t
          WHERE t.chat_id = c.id
          ORDER BY t.rowid DESC
          LIMIT 1
        ) AS active_turn_safe_error_code,
        c.pinned,
        c.archived
      FROM chats c
      LEFT JOIN projects p ON p.id = c.project_id
      WHERE c.archived = 1
      ORDER BY c.updated_at DESC, c.created_at DESC
    `,
      )
      .all();
    const items = [
      ...projectRows.map((row) => ({
        kind: "project" as const,
        sort: `${row.updated_at}:${row.created_at}`,
        item: projectFromRow(row),
      })),
      ...sessionRows.map((row) => ({
        kind: "session" as const,
        sort: `${row.updated_at}:${row.created_at}`,
        item: sessionFromRow(row),
      })),
    ].sort((left, right) => right.sort.localeCompare(left.sort));
    const visibleItems = items.slice(page.offset, page.offset + page.limit);
    return {
      projects: visibleItems
        .filter((entry) => entry.kind === "project")
        .map((entry) => entry.item as ProjectSummary),
      sessions: visibleItems
        .filter((entry) => entry.kind === "session")
        .map((entry) => entry.item as SessionSummary),
      pagination: {
        ...page,
        total: items.length,
        has_more: page.offset + page.limit < items.length,
      },
    };
  }

  listSystemEvents(
    options: { limit?: number; offset?: number } = {},
  ): SystemEventListView {
    const page = paginationInput(options);
    const events = systemEventsForButlerData(this.butlerData);
    return {
      events: events.slice(page.offset, page.offset + page.limit),
      pagination: {
        ...page,
        total: events.length,
        has_more: page.offset + page.limit < events.length,
      },
      generated_at: new Date().toISOString(),
      raw_text_included: false,
    };
  }

  getUsageMonitor(
    options: { sessionId?: string; sinceTs?: number | null } = {},
  ): UsageMonitorView {
    return {
      ...readUsageMonitor({
        butlerData: this.butlerData,
        sessionId: options.sessionId,
        sinceTs: options.sinceTs ?? null,
      }),
      generated_at: new Date().toISOString(),
      raw_text_included: false,
    };
  }

  listProjectSessions(projectId?: string): ProjectSessionListView {
    return {
      project_id: projectId,
      sessions: this.listSessions({ kind: "project", projectId }).sessions,
    };
  }

  searchCommandPalette(query: string): CommandPaletteView {
    const needle = query.trim().toLocaleLowerCase("en-US");
    const matches = (value: string) =>
      !needle || value.toLocaleLowerCase("en-US").includes(needle);
    const results = [
      ...this.listSessions()
        .sessions.filter((session) => matches(session.title))
        .map((session) => ({
          id: session.id,
          kind:
            session.kind === "project"
              ? ("project_session" as const)
              : ("chat" as const),
          title: session.title,
          subtitle: session.kind === "project" ? "Project chat" : "Chat",
          route: `session:${session.id}`,
        })),
      ...this.listProjects()
        .projects.filter((project) => matches(project.display_name))
        .map((project) => ({
          id: project.id,
          kind: "project" as const,
          title: project.display_name,
          subtitle: "Project",
          route: `project:${project.id}`,
        })),
      ...this.listAutomations()
        .automations.filter((automation) => matches(automation.title))
        .map((automation) => ({
          id: automation.id,
          kind: "automation" as const,
          title: automation.title,
          subtitle: automation.interval_label,
          route: `automation:${automation.id}`,
        })),
      ...[
        "General",
        "Appearance",
        "Server/Bridge",
        "Models/Access",
        "Privacy/Data",
        "Diagnostics",
        "System events",
        "Archived",
      ]
        .filter(matches)
        .map((section) => ({
          id: `settings:${section.toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/gu, "-")}`,
          kind: "settings" as const,
          title: section,
          subtitle: "Settings",
          route: `settings:${section}`,
        })),
    ];
    return { results: results.slice(0, 30) };
  }

  getSettings(): SettingsView {
    const stored = this.repairGatewayProfileState(
      this.readSetting<Partial<SettingsView>>("settings") ?? {},
    );
    const registeredModels = this.registeredModelMetadata();
    const consolidationModel = readProfilingExtractorModelConfig(
      this.butlerData,
    );
    const configUserSettings = readConfigUserSettings(this.butlerData);
    const configDefaultModel = readConfigDefaultModel(this.butlerData);
    const modelMetadata = resolveRegisteredRuntimeModelMetadata(
      stored.model ?? configDefaultModel ?? DEFAULT_MODEL_REF,
      registeredModels,
    );
    const storedReasoning = stored.reasoning_effort ?? DEFAULT_REASONING_EFFORT;
    const contextWindowTokens = clampContextWindowTokens(
      stored.context_window_tokens,
      modelMetadata.context_window_tokens,
    );
    const mainScreenThemeCustomColors =
      normalizedMainScreenThemeColorsOrDefault(
        stored.main_screen_theme_custom_colors,
      );
    const mainScreenThemePreset = normalizedMainScreenThemePresetOrDefault(
      stored.main_screen_theme_preset,
      mainScreenThemeCustomColors,
    );
    return {
      bridge_mode: this.bridgeMode,
      gateway_profile: "electron",
      server_url: stored.server_url ?? this.serverUrl,
      default_project_workspace_label: safeWorkspaceLabel(
        this.projectWorkspaceRoot,
      ),
      language: stored.language === "ko" || stored.language === "en"
        ? stored.language
        : (configUserSettings.language ?? "en"),
      timezone: normalizeTimezone(
        stored.timezone ?? configUserSettings.timezone,
      ),
      model: modelMetadata.model_ref,
      reasoning_effort: modelMetadata.reasoning_efforts.includes(
        storedReasoning,
      )
        ? storedReasoning
        : modelMetadata.default_reasoning_effort,
      consolidation_model:
        consolidationModel.configured_model ?? PROFILE_EXTRACTOR_MODEL_DEFAULT,
      consolidation_reasoning_effort: consolidationModel.reasoning_effort,
      effective_consolidation_model: consolidationModel.uses_butler_model
        ? modelMetadata.model_ref
        : consolidationModel.effective_model,
      consolidation_uses_butler_model: consolidationModel.uses_butler_model,
      context_window_tokens: contextWindowTokens,
      worker_model_rules: normalizeWorkerModelRules(
        stored.worker_model_rules,
        registeredModels,
      ),
      access_mode: stored.access_mode ?? "full_access",
      plan_mode_default: stored.plan_mode_default ?? false,
      follow_up_behavior: stored.follow_up_behavior ?? "queue",
      multiline_send_behavior: normalizedMultilineSendBehaviorOrDefault(
        stored.multiline_send_behavior,
      ),
      appearance_theme: stored.appearance_theme ?? "system",
      main_screen_theme: normalizedMainScreenThemeOrDefault(
        stored.main_screen_theme,
      ),
      main_screen_theme_preset: mainScreenThemePreset,
      main_screen_theme_custom_colors: mainScreenThemeCustomColors,
      translucent_sidebar: stored.translucent_sidebar ?? true,
      diagnostics_enabled: stored.diagnostics_enabled ?? false,
      desktop_notifications: normalizeDesktopNotificationSettings(
        stored.desktop_notifications,
      ),
      desktop_tray_enabled: stored.desktop_tray_enabled ?? true,
      web_search: normalizeWebSearchSettings(
        {
          ...readConfigWebSearchSettings(this.butlerData),
          ...stored.web_search,
        },
        this.butlerData,
      ),
      profile_label: "Local Butler",
    };
  }

  private repairGatewayProfileState(
    stored: Partial<SettingsView>,
  ): Partial<SettingsView> {
    const rawProfile = (stored as Record<string, unknown>).gateway_profile;
    if (rawProfile === "electron") return stored;
    const repaired = {
      ...stored,
      gateway_profile: "electron" as const,
    };
    this.writeSetting("settings", repaired);
    this.appendEvent("settings.gateway_profile_repaired", {
      gateway_profile: "electron",
      previous_profile_kind: typeof rawProfile,
      had_previous_profile: rawProfile !== undefined,
      raw_text_included: false,
    });
    return repaired;
  }

  getModelCatalog(): ModelCatalogView {
    const localModels = this.localModelMetadata();
    return modelCatalogView(
      localModels,
      [...registeredHostedModelMetadata(this.butlerData), ...localModels],
      listProviderCredentialViews(this.butlerData),
      { defaultModelRef: readConfigDefaultModel(this.butlerData) },
    );
  }

  upsertProviderCredential(
    input: ProviderCredentialUpsertRequest,
  ): ProviderCredentialMutationResult {
    try {
      const credential = upsertProviderApiKeyCredential(
        {
          providerId: input.provider_id as HostedModelProviderId,
          apiKey: input.api_key,
          label: input.label,
          credentialId: input.credential_id,
        },
        this.butlerData,
      );
      const view = credentialView(credential);
      this.appendEvent("settings.provider_credential_saved", {
        provider_id: view.provider_id,
        auth_type: view.auth_type,
        credential_id: view.id,
        masked_value: view.masked_value,
      });
      return {
        credential: view,
        catalog: this.getModelCatalog(),
      };
    } catch (error) {
      throw new AppStoreOperationError(
        400,
        "provider_credential_save_failed",
        error instanceof Error
          ? error.message
          : "Provider credential save failed.",
      );
    }
  }

  registerHostedModel(
    input: HostedModelRegistrationRequest,
  ): HostedModelRegistrationResult {
    try {
      const config = registerHostedModelConfig(
        {
          providerId: input.provider_id as HostedModelProviderId,
          modelId: input.model_id,
          displayName: input.display_name,
          authType: input.auth_type,
          credentialId: input.credential_id,
          apiKey: input.api_key,
          credentialLabel: input.credential_label,
          apiBaseUrl: input.api_base_url,
        },
        this.butlerData,
      );
      const model = registeredHostedModelMetadata(this.butlerData).find(
        (candidate) => candidate.model_ref === config.model_ref,
      );
      if (!model) throw new Error("Registered model metadata was not found.");
      this.normalizeStoredModelSettings();
      this.appendEvent("settings.hosted_model_registered", {
        model_ref: model.model_ref,
        provider_id: model.provider_id,
        auth_type: model.auth_type,
        credential_id: model.credential_id,
      });
      return {
        model,
        catalog: this.getModelCatalog(),
      };
    } catch (error) {
      throw new AppStoreOperationError(
        400,
        "hosted_model_registration_failed",
        error instanceof Error
          ? error.message
          : "Hosted model registration failed.",
      );
    }
  }

  deleteHostedModel(modelRef: string): HostedModelDeletionResult {
    const targetModelRef = this.resolveRegisteredHostedModelRef(modelRef);
    if (!targetModelRef) {
      throw new AppStoreOperationError(
        404,
        "hosted_model_delete_failed",
        "Hosted model is not registered.",
      );
    }
    if (this.hasActiveTurnUsingModel(targetModelRef)) {
      throw new AppStoreOperationError(
        409,
        "hosted_model_in_use",
        "This hosted model is currently used by an active turn. Try again after the turn finishes.",
      );
    }
    let removed;
    try {
      removed = deleteHostedModelConfig(targetModelRef, this.butlerData);
    } catch (error) {
      throw new AppStoreOperationError(
        error instanceof Error && error.message.includes("not registered")
          ? 404
          : 400,
        "hosted_model_delete_failed",
        error instanceof Error
          ? error.message
          : "Hosted model deletion failed.",
      );
    }
    const fallbackModelRef =
      this.registeredModelMetadata().find((model) => model.runtime_supported)
        ?.model_ref ?? DEFAULT_MODEL_REF;
    this.rewriteStoredModelRefs(removed.model_ref, fallbackModelRef);
    this.normalizeStoredModelSettings();
    this.appendEvent("settings.hosted_model_deleted", {
      removed_model_ref: removed.model_ref,
      provider_id: removed.provider_id,
    });
    return {
      removed_model_ref: removed.model_ref,
      catalog: this.getModelCatalog(),
    };
  }

  listMcpServers(): McpServerListView {
    return listMcpServers(this.butlerData);
  }

  createMcpServer(input: McpServerUpsertRequest): McpServerMutationResult {
    try {
      return { server: upsertMcpServer(this.butlerData, input) };
    } catch (error) {
      throw new AppStoreOperationError(
        400,
        "mcp_server_save_failed",
        error instanceof Error ? error.message : "MCP server save failed.",
      );
    }
  }

  updateMcpServer(
    serverId: string,
    input: McpServerUpsertRequest,
  ): McpServerMutationResult {
    try {
      return { server: updateMcpServer(this.butlerData, serverId, input) };
    } catch (error) {
      throw new AppStoreOperationError(
        error instanceof Error && error.message.includes("not found")
          ? 404
          : 400,
        "mcp_server_update_failed",
        error instanceof Error ? error.message : "MCP server update failed.",
      );
    }
  }

  deleteMcpServer(serverId: string): McpServerDeleteResult {
    return deleteMcpServer(this.butlerData, serverId);
  }

  async probeMcpServer(serverId: string): Promise<McpCapabilitiesView> {
    return {
      servers: [
        await probeMcpServer({
          butlerData: this.butlerData,
          serverId,
        }),
      ],
    };
  }

  async listMcpCapabilities(): Promise<McpCapabilitiesView> {
    return await listMcpServerCapabilities({
      butlerData: this.butlerData,
      includeDisabled: true,
    });
  }

  getSkillSettings(): SkillSettingsView {
    return skillSettingsView({
      butlerHome: this.butlerHome,
      butlerData: this.butlerData,
      projects: this.listProjects().projects.map((project) => ({
        id: project.id,
        display_name: project.display_name,
      })),
    });
  }

  private loadedSkillNamesForSession(
    sessionId: string,
    turnId?: string,
  ): string[] {
    const runtimeSessionId = sessionHintForRow(sessionId);
    const transcriptIds = [
      runtimeSessionId,
      ...(runtimeSessionId === sessionId ? [] : [sessionId]),
    ];
    for (const transcriptId of transcriptIds) {
      const events = readTranscriptFromDataHome(this.butlerData, transcriptId);
      for (let index = events.length - 1; index >= 0; index -= 1) {
        const skillNames = loadedSkillNamesFromTranscriptEvent(
          events[index],
          turnId,
        );
        if (skillNames !== null) return skillNames;
      }
    }
    return [];
  }

  importSkill(input: {
    name: string;
    bytes: ArrayBuffer;
    projectId?: string;
  }): SkillImportResult {
    try {
      return importSkillZip({
        butlerData: this.butlerData,
        zipName: input.name,
        bytes: input.bytes,
        projectId: input.projectId,
      });
    } catch (error) {
      throw new AppStoreOperationError(
        400,
        "skill_import_failed",
        error instanceof Error ? error.message : "Skill import failed.",
      );
    }
  }

  async discoverLocalModels(
    input: LocalModelDiscoveryRequest,
  ): Promise<LocalModelDiscoveryResult> {
    let result;
    try {
      result = await discoverLocalModels({
        serverUrl: input.server_url,
        apiType: input.api_type,
        platform: input.platform,
      });
    } catch (error) {
      throw new AppStoreOperationError(
        502,
        "local_model_discovery_failed",
        error instanceof Error
          ? error.message
          : "Local model discovery failed.",
      );
    }
    return {
      server_url: result.server_url,
      api_base_url: result.api_base_url,
      api_type: result.api_type,
      platform: result.platform,
      models: result.models.map((model) =>
        localModelConfigToMetadata({
          ...model,
          created_at: new Date(0).toISOString(),
          updated_at: new Date(0).toISOString(),
        }),
      ),
    };
  }

  registerLocalModel(
    input: LocalModelRegistrationRequest,
  ): LocalModelRegistrationResult {
    let model;
    try {
      model = upsertLocalModelConfig(
        {
          serverUrl: input.server_url,
          apiType: input.api_type,
          platform: input.platform,
          modelId: input.model_id,
          displayName: input.display_name,
          contextWindowTokens: input.context_window_tokens,
          maxOutputTokens: input.max_output_tokens,
          reasoningBudgetRatio: input.reasoning_budget_ratio,
          source: input.source,
        },
        this.butlerData,
      );
    } catch (error) {
      throw new AppStoreOperationError(
        400,
        "local_model_registration_failed",
        error instanceof Error
          ? error.message
          : "Local model registration failed.",
      );
    }
    const summary = localModelConfigToMetadata(model);
    this.appendEvent("settings.local_model_registered", {
      model_ref: summary.model_ref,
      provider_id: summary.provider_id,
      api_type: summary.api_type,
      platform: summary.platform,
      context_window_tokens: summary.context_window_tokens,
      reasoning_budget_ratio: summary.local_reasoning_budget_ratio ?? 0,
    });
    return {
      model: summary,
      catalog: this.getModelCatalog(),
    };
  }

  updateLocalModel(
    modelRef: string,
    input: LocalModelUpdateRequest,
  ): LocalModelRegistrationResult {
    let result;
    try {
      result = updateLocalModelConfig(
        modelRef,
        {
          serverUrl: input.server_url,
          apiType: input.api_type,
          platform: input.platform,
          modelId: input.model_id,
          displayName: input.display_name,
          contextWindowTokens: input.context_window_tokens,
          maxOutputTokens: input.max_output_tokens,
          reasoningBudgetRatio: input.reasoning_budget_ratio,
          source: input.source,
        },
        this.butlerData,
      );
    } catch (error) {
      throw new AppStoreOperationError(
        error instanceof Error && error.message.includes("not registered")
          ? 404
          : 400,
        "local_model_update_failed",
        error instanceof Error ? error.message : "Local model update failed.",
      );
    }
    const summary = localModelConfigToMetadata(result.model);
    if (result.previousModelRef !== summary.model_ref) {
      this.rewriteStoredModelRefs(result.previousModelRef, summary.model_ref);
    }
    this.normalizeStoredModelSettings();
    this.appendEvent("settings.local_model_updated", {
      previous_model_ref: result.previousModelRef,
      model_ref: summary.model_ref,
      provider_id: summary.provider_id,
      api_type: summary.api_type,
      platform: summary.platform,
      context_window_tokens: summary.context_window_tokens,
      reasoning_budget_ratio: summary.local_reasoning_budget_ratio ?? 0,
    });
    return {
      model: summary,
      catalog: this.getModelCatalog(),
    };
  }

  deleteLocalModel(modelRef: string): LocalModelDeletionResult {
    const targetModelRef = this.resolveRegisteredLocalModelRef(modelRef);
    if (!targetModelRef) {
      throw new AppStoreOperationError(
        404,
        "local_model_delete_failed",
        "Local model is not registered.",
      );
    }
    if (this.hasActiveTurnUsingModel(targetModelRef)) {
      throw new AppStoreOperationError(
        409,
        "local_model_in_use",
        "This local model is currently used by an active turn. Try again after the turn finishes.",
      );
    }
    let removed;
    try {
      removed = deleteLocalModelConfig(modelRef, this.butlerData);
    } catch (error) {
      throw new AppStoreOperationError(
        error instanceof Error && error.message.includes("not registered")
          ? 404
          : 400,
        "local_model_delete_failed",
        error instanceof Error ? error.message : "Local model deletion failed.",
      );
    }
    this.rewriteStoredModelRefs(removed.model_ref, DEFAULT_MODEL_REF);
    this.normalizeStoredModelSettings();
    this.appendEvent("settings.local_model_deleted", {
      removed_model_ref: removed.model_ref,
      provider_id: removed.provider_id,
    });
    return {
      removed_model_ref: removed.model_ref,
      catalog: this.getModelCatalog(),
    };
  }

  private resolveRegisteredLocalModelRef(modelRef: string): string | null {
    const trimmed = modelRef.trim();
    const asRef = trimmed.startsWith("local/") ? trimmed : `local/${trimmed}`;
    const model = this.localModelMetadata().find(
      (candidate) =>
        candidate.model_ref === asRef ||
        candidate.model_id === trimmed ||
        candidate.model_ref === trimmed,
    );
    return model?.model_ref ?? null;
  }

  private resolveRegisteredHostedModelRef(modelRef: string): string | null {
    const trimmed = modelRef.trim();
    const model = registeredHostedModelMetadata(this.butlerData).find(
      (candidate) =>
        candidate.model_ref === trimmed || candidate.model_id === trimmed,
    );
    return model?.model_ref ?? null;
  }

  private hasActiveTurnUsingModel(modelRef: string): boolean {
    const rows = this.db
      .query<{ chat_id: string }, []>(
        `
      SELECT DISTINCT chat_id
      FROM turns
      WHERE state IN ('queued', 'accepted', 'thinking', 'streaming', 'waiting_for_form', 'waiting_for_tool', 'retrying', 'cancelling')
    `,
      )
      .all();
    if (rows.length === 0) return false;
    const settings = this.getSettings();
    const registeredModels = this.registeredModelMetadata();
    for (const row of rows) {
      const stored = this.readSetting<Partial<SessionControlState>>(
        sessionControlsKey(row.chat_id),
      );
      const controls = normalizeSessionControls(
        {
          model: stored?.model ?? settings.model,
          reasoning_effort:
            stored?.reasoning_effort ?? settings.reasoning_effort,
          access_mode: stored?.access_mode ?? settings.access_mode,
          plan_mode: stored?.plan_mode ?? settings.plan_mode_default,
        },
        registeredModels,
      );
      if (controls.model === modelRef) return true;
    }
    return false;
  }

  private rewriteStoredModelRefs(
    previousModelRef: string,
    nextModelRef: string,
  ): void {
    const storedSettings = this.readSetting<Partial<SettingsView>>("settings");
    if (storedSettings) {
      this.writeSetting(
        "settings",
        rewriteSettingsModelRefs(
          storedSettings,
          previousModelRef,
          nextModelRef,
        ),
      );
    }

    const rows = this.db
      .query<SettingRow, []>(
        `
      SELECT key, value_json
      FROM app_settings
      WHERE key LIKE 'session-controls:%'
    `,
      )
      .all();
    for (const row of rows) {
      let parsed: Partial<SessionControlState>;
      try {
        parsed = JSON.parse(row.value_json) as Partial<SessionControlState>;
      } catch {
        continue;
      }
      if (parsed.model !== previousModelRef) continue;
      this.writeSetting(row.key, {
        ...parsed,
        model: nextModelRef,
      });
    }
  }

  private normalizeStoredModelSettings(): void {
    this.writeSetting("settings", this.getSettings());
    const registeredModels = this.registeredModelMetadata();
    const rows = this.db
      .query<SettingRow, []>(
        `
      SELECT key, value_json
      FROM app_settings
      WHERE key LIKE 'session-controls:%'
    `,
      )
      .all();
    for (const row of rows) {
      let parsed: Partial<SessionControlState>;
      try {
        parsed = JSON.parse(row.value_json) as Partial<SessionControlState>;
      } catch {
        continue;
      }
      this.writeSetting(
        row.key,
        normalizeSessionControls(parsed, registeredModels),
      );
    }
  }

  updateSettings(input: UpdateSettingsRequest): SettingsView {
    const registeredModels = this.registeredModelMetadata();
    const sanitized = sanitizeSettingsUpdate(input, registeredModels);
    const webSearchPatch = sanitized.web_search
      ? webSearchSettingsPatchFrom(sanitized.web_search)
      : undefined;
    const webSearchApiKey = sanitized.web_search?.api_key;
    if (typeof sanitized.consolidation_model === "string") {
      setProfilingExtractorModel(
        this.butlerData,
        sanitized.consolidation_model,
      );
    }
    if (typeof sanitized.consolidation_reasoning_effort === "string") {
      setProfilingExtractorReasoningEffort(
        this.butlerData,
        sanitized.consolidation_reasoning_effort,
      );
    }
    const current = this.getSettings();
    if (webSearchApiKey) {
      writeWebSearchProviderApiKey(
        this.butlerData,
        webSearchPatch?.provider ?? current.web_search.provider,
        webSearchApiKey,
      );
    }
    let nextProjectWorkspaceRoot = this.projectWorkspaceRoot;
    if (
      typeof input.default_project_folder_selection_token === "string" &&
      input.default_project_folder_selection_token.trim()
    ) {
      const selectedPath = readProjectFolderSelectionToken(
        input.default_project_folder_selection_token,
        this.folderSelectionSecret,
      );
      nextProjectWorkspaceRoot = this.validateProjectFolder(selectedPath);
    }
    const candidate: SettingsView = {
      ...current,
      ...sanitized,
      desktop_notifications: sanitized.desktop_notifications
        ? normalizeDesktopNotificationSettings({
            ...current.desktop_notifications,
            ...sanitized.desktop_notifications,
          })
        : current.desktop_notifications,
      web_search: normalizeWebSearchSettings(
        {
          ...current.web_search,
          ...webSearchPatch,
        },
        this.butlerData,
      ),
      default_project_workspace_label: safeWorkspaceLabel(
        nextProjectWorkspaceRoot,
      ),
      profile_label: current.profile_label,
    };
    const modelMetadata = resolveRegisteredRuntimeModelMetadata(
      candidate.model,
      registeredModels,
    );
    const currentModelMetadata = resolveRegisteredRuntimeModelMetadata(
      current.model,
      registeredModels,
    );
    const contextWindowTokens =
      "context_window_tokens" in input
        ? candidate.context_window_tokens
        : current.context_window_tokens >=
            currentModelMetadata.context_window_tokens
          ? modelMetadata.context_window_tokens
          : candidate.context_window_tokens;
    const next: SettingsView = {
      ...candidate,
      model: modelMetadata.model_ref,
      reasoning_effort: modelMetadata.reasoning_efforts.includes(
        candidate.reasoning_effort,
      )
        ? candidate.reasoning_effort
        : modelMetadata.default_reasoning_effort,
      effective_consolidation_model: candidate.consolidation_uses_butler_model
        ? modelMetadata.model_ref
        : candidate.effective_consolidation_model,
      context_window_tokens: clampContextWindowTokens(
        contextWindowTokens,
        modelMetadata.context_window_tokens,
      ),
    };
    if (sanitized.web_search) {
      writeConfigWebSearchSettings(this.butlerData, next.web_search);
    }
    const configUserPatch: ConfigUserSettings = {};
    if (sanitized.timezone) {
      configUserPatch.timezone = next.timezone;
    }
    if (sanitized.language) {
      configUserPatch.language = next.language;
      if (!readConfigUserSettings(this.butlerData).responseLanguage) {
        configUserPatch.responseLanguage = next.language;
      }
    }
    if (Object.keys(configUserPatch).length > 0) {
      writeConfigUserSettings(this.butlerData, configUserPatch);
    }
    this.writeSetting("settings", next);
    this.appendEvent("settings.updated", {
      settings: {
        bridge_mode: next.bridge_mode,
        language: next.language,
        model: next.model,
        reasoning_effort: next.reasoning_effort,
        timezone: next.timezone,
        consolidation_model: next.consolidation_model,
        consolidation_reasoning_effort: next.consolidation_reasoning_effort,
        effective_consolidation_model: next.effective_consolidation_model,
        context_window_tokens: next.context_window_tokens,
        worker_model_rule_count: next.worker_model_rules.filter(
          (rule) => rule.enabled,
        ).length,
        access_mode: next.access_mode,
        appearance_theme: next.appearance_theme,
        main_screen_theme: next.main_screen_theme,
        main_screen_theme_preset: next.main_screen_theme_preset,
        translucent_sidebar: next.translucent_sidebar,
        desktop_notifications: next.desktop_notifications,
        desktop_tray_enabled: next.desktop_tray_enabled,
        web_search: next.web_search,
        default_project_workspace_label: next.default_project_workspace_label,
      },
    });
    if (nextProjectWorkspaceRoot !== this.projectWorkspaceRoot) {
      this.projectWorkspaceRoot = nextProjectWorkspaceRoot;
      this.writeSetting(
        DEFAULT_PROJECT_WORKSPACE_SETTING_KEY,
        this.projectWorkspaceRoot,
      );
    }
    return next;
  }

  getPersonalization(): PersonalizationView {
    const profile = readPersonalizationProfile(this.butlerData);
    const profiling = readProfilingConsentSnapshot(this.butlerData);
    const extractorModel = readProfilingExtractorModelConfig(this.butlerData);
    const settings = this.getSettings();
    const configUserSettings = readConfigUserSettings(this.butlerData);
    return {
      persona: readPrivateText(join(this.butlerData, "personas", "active.md")),
      eol: readPrivateText(join(this.butlerData, "eol.md")),
      updated_at: new Date().toISOString(),
      response_language: configUserSettings.responseLanguage ??
        (settings.language === "ko" ? "ko" : "en"),
      persona_presets: readPersonaPresets(
        this.butlerHome,
        settings.language,
      ),
      profile: {
        ...profile,
        storage_label: PERSONALIZATION_PROFILE_STORAGE_LABEL,
      },
      profiling: {
        mode: profiling.mode,
        enabled: profiling.mode !== "off",
        consent_version: profiling.consent_version,
        consented_at: profiling.consented_at,
        storage_label: PROFILE_BLACK_BOX_STORAGE_LABEL,
        raw_profile_browser_visible: false,
        extractor_model: extractorModel.configured_model ?? "default",
        extractor_reasoning_effort: extractorModel.reasoning_effort,
        effective_extractor_model: extractorModel.effective_model,
        extractor_uses_butler_model: extractorModel.uses_butler_model,
      },
    };
  }

  updatePersonalization(
    input: UpdatePersonalizationRequest,
  ): PersonalizationView {
    if (typeof input.persona === "string") {
      const personaPath = join(this.butlerData, "personas", "active.md");
      mkdirSync(join(this.butlerData, "personas"), { recursive: true });
      const personaText = boundedPrivateText(input.persona);
      backupPrivatePersonalizationFile(
        this.butlerData,
        personaPath,
        "persona-active",
        personaText,
      );
      writeFileSync(personaPath, personaText, "utf8");
    }
    if (typeof input.eol === "string") {
      mkdirSync(this.butlerData, { recursive: true });
      const eolPath = join(this.butlerData, "eol.md");
      const eolText = boundedPrivateText(input.eol);
      backupPrivatePersonalizationFile(
        this.butlerData,
        eolPath,
        "eol",
        eolText,
      );
      writeFileSync(eolPath, eolText, "utf8");
    }
    const updatedProfile = input.profile
      ? updatePersonalizationProfile(this.butlerData, input.profile)
      : null;
    const updatedProfiling = input.profiling?.mode
      ? setProfilingMode(this.butlerData, input.profiling.mode)
      : null;
    const updatedExtractorModel =
      typeof input.profiling?.extractor_model === "string"
        ? setProfilingExtractorModel(
            this.butlerData,
            input.profiling.extractor_model,
          )
        : null;
    const updatedExtractorReasoning =
      typeof input.profiling?.extractor_reasoning_effort === "string"
        ? setProfilingExtractorReasoningEffort(
            this.butlerData,
            input.profiling.extractor_reasoning_effort,
          )
        : null;
    if (input.response_language === "en" || input.response_language === "ko") {
      writeConfigUserSettings(this.butlerData, {
        responseLanguage: input.response_language,
      });
    }
    const clearedProfile = input.profiling?.clear_profile
      ? clearProfilingData(this.butlerData)
      : null;
    this.appendEvent("personalization.updated", {
      persona_chars:
        typeof input.persona === "string"
          ? boundedPrivateText(input.persona).length
          : undefined,
      eol_chars:
        typeof input.eol === "string"
          ? boundedPrivateText(input.eol).length
          : undefined,
      profile_fields: updatedProfile
        ? Object.keys(input.profile ?? {}).sort()
        : undefined,
      profiling_mode: updatedProfiling?.mode,
      profiling_extractor_model:
        updatedExtractorModel?.configured_model ?? undefined,
      profiling_extractor_reasoning_effort:
        updatedExtractorReasoning?.reasoning_effort,
      response_language: input.response_language,
      profile_black_box_cleared: clearedProfile
        ? {
            removed_candidates: clearedProfile.removed_candidates,
            removed_stable_entries: clearedProfile.removed_stable_entries,
            removed_runtime_projections:
              clearedProfile.removed_runtime_projections,
          }
        : undefined,
    });
    return this.getPersonalization();
  }

  async importPersonalizationProfile(
    input: PersonalizationProfileMigrationRequest,
  ): Promise<PersonalizationProfileMigrationResultView> {
    const result = await importProfileCandidatesFromThirdPartyDumpWithModel(
      this.butlerData,
      {
        source: input.source,
        text: input.text,
        model: input.model,
      },
    );
    this.appendEvent("personalization.profile_imported", {
      source: result.source,
      import_id: result.import_id,
      profiling_enabled: result.profiling_enabled,
      model_called: result.model_called,
      imported_candidate_count: result.imported_candidate_count,
      promoted_count: result.promoted_count,
      stable_entry_count: result.stable_entry_count,
      raw_text_included: false,
    });
    return {
      profiling_enabled: result.profiling_enabled,
      mode: result.mode,
      source: result.source,
      import_id: result.import_id,
      imported_candidate_count: result.imported_candidate_count,
      promoted_count: result.promoted_count,
      skipped_count: result.skipped_count,
      stable_entry_count: result.stable_entry_count,
      projection_written: result.projection_written,
      raw_text_included: false,
      model_called: result.model_called,
      fallback_used: false,
      personalization: this.getPersonalization(),
    };
  }

  getSessionControlsView(sessionId: string): SessionControlsView {
    this.ensureChat(sessionId);
    return {
      session_id: sessionId,
      controls: this.getSessionControls(sessionId),
    };
  }

  updateSessionControlsView(
    sessionId: string,
    input: Partial<SessionControlState>,
  ): SessionControlsView {
    this.ensureChat(sessionId);
    return {
      session_id: sessionId,
      controls: this.updateSessionControls(sessionId, input),
    };
  }

  getSessionControls(sessionId: string): SessionControlState {
    const settings = this.getSettings();
    const stored =
      this.hasExplicitSessionControls(sessionId)
        ? this.readSetting<Partial<SessionControlState>>(
          sessionControlsKey(sessionId),
        ) ?? {}
        : {};
    const registeredModels = this.registeredModelMetadata();
    return normalizeSessionControls(
      {
        model: stored.model ?? settings.model,
        reasoning_effort: stored.reasoning_effort ?? settings.reasoning_effort,
        access_mode: stored.access_mode ?? settings.access_mode,
        plan_mode: stored.plan_mode ?? settings.plan_mode_default,
      },
      registeredModels,
    );
  }

  updateSessionControls(
    sessionId: string,
    input: Partial<SessionControlState>,
  ): SessionControlState {
    const current = this.getSessionControls(sessionId);
    const next = normalizeSessionControls(
      { ...current, ...input },
      this.registeredModelMetadata(),
    );
    this.writeSetting(sessionControlsKey(sessionId), next);
    this.writeSetting(sessionControlsExplicitKey(sessionId), true);
    this.appendEvent("session.controls_updated", {
      session_id: sessionId,
      model: next.model,
      reasoning_effort: next.reasoning_effort,
      access_mode: next.access_mode,
      plan_mode: next.plan_mode,
    });
    return next;
  }

  private controlsForMessageSend(
    sessionId: string,
    input: Partial<SessionControlState>,
  ): SessionControlState {
    return hasSessionControlInput(input)
      ? this.updateSessionControls(sessionId, input)
      : this.getSessionControls(sessionId);
  }

  private hasExplicitSessionControls(sessionId: string): boolean {
    return (
      this.readSetting<boolean>(sessionControlsExplicitKey(sessionId)) === true
    );
  }

  getProjectDashboard(projectId: string): ProjectDashboardView {
    const row = this.getProjectRow(projectId);
    if (!row)
      throw new AppStoreOperationError(
        404,
        "project_not_found",
        "Project not found.",
      );
    const sessions = this.listSessions({ kind: "project", projectId }).sessions;
    const project = projectFromRow(row, sessions);
    const now = new Date();
    const dayStart = startOfUtcDay(now);
    const days = Array.from({ length: 30 }, (_, offset) => {
      const date = new Date(dayStart.getTime() - (29 - offset) * 86_400_000);
      return {
        date: date.toISOString().slice(0, 10),
        count: 0,
      };
    });
    const firstDay = `${days[0]!.date}T00:00:00.000Z`;
    const activityRows = this.db
      .query<{ day: string; count: number }, [string, string]>(
        `
      SELECT substr(m.created_at, 1, 10) AS day, COUNT(*) AS count
      FROM messages m
      JOIN chats c ON c.id = m.chat_id
      WHERE c.project_id = ? AND m.created_at >= ?
      GROUP BY day
      ORDER BY day ASC
    `,
      )
      .all(projectId, firstDay);
    const countByDay = new Map(
      activityRows.map((item) => [item.day, item.count]),
    );
    const activityDays = days.map((day) => ({
      ...day,
      count: countByDay.get(day.date) ?? 0,
    }));
    const recent7Start = new Date(
      dayStart.getTime() - 6 * 86_400_000,
    ).toISOString();
    const recent30Start = firstDay;
    const recentMessages7d = this.projectMessageCountSince(
      projectId,
      recent7Start,
    );
    const recentMessages30d = this.projectMessageCountSince(
      projectId,
      recent30Start,
    );
    const projectDocumentCatalog = loadProjectDocumentCatalog({
      butlerDataRoot: this.butlerData,
      project: row,
    });
    return {
      project,
      stats: {
        active_sessions: sessions.filter((session) => !session.archived).length,
        archived_sessions: sessions.filter((session) => session.archived)
          .length,
        recent_messages_7d: recentMessages7d,
        recent_messages_30d: recentMessages30d,
        specs: projectDocumentCatalog.stats.specs,
        plans: projectDocumentCatalog.stats.plans,
      },
      activity: {
        days: activityDays,
      },
      documents: projectDocumentCatalog.documents,
      generated_at: new Date().toISOString(),
    };
  }

  getContextDetails(sessionId: string): ContextDetailsView {
    this.ensureChat(sessionId);
    const controls = this.getSessionControls(sessionId);
    const metadata = resolveModelMetadata(
      controls.model,
      this.registeredModelMetadata(),
    );
    const settings = this.getSettings();
    const sessionContextWindowTokens = contextWindowTokensForSessionModel(
      settings,
      metadata,
    );
    const budgetConfig = resolveContextBudgetConfig(metadata.model_ref, {
      contextWindowTokens: sessionContextWindowTokens,
    });
    const personalization = this.getPersonalization();
    const runtimeSessionId = sessionHintForRow(sessionId);
    const messages = this.sessionViewMessages(sessionId);
    const turns = this.listTurns(sessionId);
    const latestTurn = turns.at(-1);
    const project = this.getProjectForSession(sessionId);
    const latestUserMessage = [...messages]
      .reverse()
      .find((message) => message.role === "user");
    const livePromptUsage = latestLivePromptUsage({
      butlerData: this.butlerData,
      runtimeSessionId,
      turnId: latestTurn?.id,
    });
    const staticContextTokens = estimateContextTokensForModel(
      "Butler runtime contract, role policy, transport contract, and safety rules.",
      metadata.model_ref,
    ).tokens;
    const liveConfigurationTokens = estimateContextTokensForModel(
      JSON.stringify({
        language: settings.language,
        persona: personalization.persona ? "configured" : "empty",
        eol: personalization.eol ? "configured" : "empty",
        model: metadata.model_ref,
        access_mode: controls.access_mode,
        plan_mode: controls.plan_mode,
      }),
      metadata.model_ref,
    ).tokens;
    const runtimeStateTokens = estimateContextTokensForModel(
      JSON.stringify({
        runtimeSessionId,
        projectId: project?.id ?? null,
        sessionKind: this.getChatRow(sessionId)?.kind ?? "chat",
        turnCount: turns.length,
      }),
      metadata.model_ref,
    ).tokens;
    const currentInputTokens = estimateContextTokensForModel(
      latestUserMessage?.text ?? "",
      metadata.model_ref,
    ).tokens;
    const recentConversationTokens = estimateContextTokensForModel(
      messages
        .slice(-16)
        .map((message) => `${message.role}: ${message.text}`)
        .join("\n"),
      metadata.model_ref,
    ).tokens;
    const latestCompaction = [
      ...readCompactionSnapshots({
        butlerData: this.butlerData,
        sessionId: runtimeSessionId,
      }),
    ]
      .reverse()
      .find((snapshot) => snapshot.status === "ok");
    const compactionTokens = estimateContextTokensForModel(
      latestCompaction?.summary ?? "",
      metadata.model_ref,
    ).tokens;
    const artifacts = this.listArtifacts(sessionId);
    const messageFiles = this.listMessageFilesForSession(sessionId);
    const referenceTokens = Math.max(
      0,
      artifacts.length * 48 + messageFiles.length * 24,
    );
    const retrievedContextTokens = compactionTokens;
    const knownPromptTokens =
      staticContextTokens +
      liveConfigurationTokens +
      runtimeStateTokens +
      retrievedContextTokens +
      currentInputTokens +
      referenceTokens;
    const measuredWorkingContextTokens = livePromptUsage
      ? Math.max(0, livePromptUsage.promptTokens - knownPromptTokens)
      : 0;
    const workingContextTokens = Math.max(
      recentConversationTokens,
      measuredWorkingContextTokens,
    );
    const workingBudget = evaluateWorkingContextBudget({
      modelRef: metadata.model_ref,
      staticContextTokens,
      liveConfigurationTokens,
      runtimeStateTokens,
      workingContextTokens:
        workingContextTokens +
        retrievedContextTokens +
        currentInputTokens +
        referenceTokens,
      overrides: {
        contextWindowTokens: budgetConfig.contextWindowTokens,
      },
    });
    const categories = [
      contextCategory(
        "static",
        "Static Context",
        staticContextTokens,
        "static_context",
        budgetConfig.contextWindowTokens,
        "Stable runtime and role contract.",
      ),
      contextCategory(
        "live-config",
        "Live Configuration",
        liveConfigurationTokens,
        "live_configuration",
        budgetConfig.contextWindowTokens,
        "Latest EOL, persona, settings, rules, and profile projection.",
      ),
      contextCategory(
        "runtime-state",
        "Runtime State",
        runtimeStateTokens,
        "runtime_state",
        budgetConfig.contextWindowTokens,
        "Protected session, project, transport, BTCC, worker, and task state.",
      ),
      contextCategory(
        "working",
        "Working Context",
        workingContextTokens,
        "working_context",
        budgetConfig.contextWindowTokens,
        "Recent conversation suffix and current turn working material.",
      ),
      contextCategory(
        "retrieved",
        "Retrieved Context",
        retrievedContextTokens,
        "retrieved_context",
        budgetConfig.contextWindowTokens,
        "Hot cache, project memory, and latest compaction summary when present.",
      ),
      contextCategory(
        "current-input",
        "Current User Input",
        currentInputTokens,
        "current_input",
        budgetConfig.contextWindowTokens,
        "Latest inbound message and current attachment references.",
      ),
      contextCategory(
        "references",
        "References",
        referenceTokens,
        "references",
        budgetConfig.contextWindowTokens,
        `${artifacts.length + messageFiles.length} stable local reference(s).`,
      ),
      contextCategory(
        "output-reserve",
        "Output Reserve",
        workingBudget.reservedOutputTokens,
        "output_reserve",
        budgetConfig.contextWindowTokens,
        "Reserved for the assistant response.",
      ),
      contextCategory(
        "tool-reserve",
        "Tool Reserve",
        workingBudget.reservedToolTokens,
        "tool_reserve",
        budgetConfig.contextWindowTokens,
        "Reserved for tool-call and tool-result growth.",
      ),
      contextCategory(
        "compaction-reserve",
        "Compaction Reserve",
        workingBudget.compactionPromptReserveTokens,
        "compaction_reserve",
        budgetConfig.contextWindowTokens,
        "Reserved so auto-compaction can run before hard pressure.",
      ),
    ];
    const used = categories.reduce((sum, item) => sum + item.used_tokens, 0);
    const budget = budgetConfig.contextWindowTokens;
    const ratio = used / budget;
    return {
      session_id: sessionId,
      model_ref: metadata.model_ref,
      provider_id: metadata.provider_id,
      model_id: metadata.model_id,
      token_count_source: livePromptUsage
        ? livePromptUsage.source
        : workingBudget.tokenEstimator,
      used_tokens: used,
      budget_tokens: budget,
      max_output_tokens: metadata.max_output_tokens,
      available_working_context_tokens:
        workingBudget.availableWorkingContextTokens,
      used_working_context_tokens: workingBudget.workingContextTokens,
      usable_user_message_tokens: workingBudget.usableUserMessageTokens,
      auto_compact_at_tokens: Math.floor(
        workingBudget.availableWorkingContextTokens *
          WORKING_CONTEXT_AUTO_COMPACT_RATIO,
      ),
      hard_pressure_at_tokens: Math.floor(
        workingBudget.availableWorkingContextTokens *
          WORKING_CONTEXT_HARD_PRESSURE_RATIO,
      ),
      ratio,
      status:
        workingBudget.shouldHardPressure || workingBudget.shouldAutoCompact
          ? "high"
          : workingBudget.usedWorkingRatio >= 0.7
            ? "medium"
            : "low",
      categories,
      updated_at: new Date().toISOString(),
    };
  }

  getSessionSummary(sessionId: string): SessionSummaryView {
    const session = this.getSession(sessionId);
    const turns = this.listTurns(sessionId);
    const latestTurn = turns.at(-1);
    const messages = this.listMessages(sessionId);
    const latestProgress = latestTurn
      ? this.sessionViewTurn(latestTurn).progress
      : {
          summary: messages.at(-1)
            ? "Latest message delivered"
            : "No progress yet",
          updated_at: session.updated_at,
          state: "idle" as const,
          safe_progress_rows: [],
        };
    const activeWorkStreamTurnId = latestTurn && isActiveSessionTurnState(latestTurn.state)
      ? latestTurn.id
      : undefined;
    const now = new Date().toISOString();
    return {
      session_id: session.id,
      latest_progress: latestProgress,
      turn_state: latestTurn?.state ?? "idle",
      branch_info: this.branchInfoForSession(sessionId),
      artifacts: messages
        .flatMap((message) => message.artifacts ?? [])
        .slice(-20),
      skills_used: this.loadedSkillNamesForSession(sessionId, latestTurn?.id),
      context_details: this.getContextDetails(sessionId),
      safe_errors: messages
        .filter((message) => message.safe_error_code)
        .slice(-5)
        .map((message) => ({
          code: message.safe_error_code!,
          message: "A safe app-visible error occurred.",
          created_at: message.updated_at,
        })),
      automation_targets: this.listAutomationTargets(sessionId),
      worker_activity: this.listWorkerActivity({
        sessionId,
        includeHistory: false,
      }).workers.filter(isActiveWorkerActivity),
      work_streams: this.listActiveWorkStreams(sessionId, undefined, activeWorkStreamTurnId),
      staleness: {
        state: "fresh",
        updated_at: now,
        source: "app-server",
      },
    };
  }

  refreshSessionProjection(sessionId: string): number {
    this.reconcileDeliveredSystemResponderTurns(sessionId);
    return this.syncAppTransportEventsForChat(sessionId);
  }

  getSessionView(sessionId: string): SessionView {
    const session = this.getSession(sessionId);
    const turns = this.listTurns(sessionId);
    const latestTurn = turns.at(-1);
    const messages = this.sessionViewMessages(sessionId);
    const latestMessage = messages.at(-1);
    const latestTurnHasOutOfBandReport = Boolean(
      latestTurn &&
      !latestTurn.user_message_id &&
      latestTurn.state === "delivered" &&
      latestMessage?.role === "assistant" &&
      !latestMessage.turn_id &&
      latestMessage.created_at >= latestTurn.created_at,
    );
    const latestTurnView = latestTurn
      ? this.sessionViewTurn(latestTurn, {
          suppressProgressRows: latestTurnHasOutOfBandReport,
        })
      : null;
    const activeTurn =
      latestTurnView && isActiveSessionTurnState(latestTurnView.state)
        ? latestTurnView
        : null;
    const runtimeSessionId = sessionHintForRow(sessionId);
    const activeWorkStreamTurnId = activeTurn?.id;
    const workStreams = this.listActiveWorkStreams(
      sessionId,
      runtimeSessionId,
      activeWorkStreamTurnId,
    );
    const now = new Date().toISOString();
    const artifacts = this.listArtifacts(sessionId);
    const context = this.getContextDetails(sessionId);
    const branch = this.branchInfoForSession(sessionId);
    const skillsUsed = this.loadedSkillNamesForSession(
      sessionId,
      latestTurn?.id,
    );
    const automations = this.listAutomationTargets(sessionId);
    const workers = this.listWorkerActivity({
      sessionId,
      includeHistory: false,
    }).workers;
    const errors = messages
      .filter((message) => message.safe_error_code)
      .slice(-5)
      .map((message) => ({
        code: message.safe_error_code!,
        message: "A safe app-visible error occurred.",
        created_at: message.updated_at,
      }));
    const nextCursor = maxMessageCursor(messages);
    return {
      protocol_version: APP_PROTOCOL_VERSION,
      session_id: session.id,
      kind: session.kind,
      project_id: session.project_id,
      status: sessionViewStatus(latestTurnView?.state),
      active_turn: activeTurn,
      latest_turn: latestTurnView,
      messages,
      message_window: {
        next_cursor: nextCursor,
        complete: messages.length < 200,
      },
      workers,
      work_streams: workStreams,
      artifacts,
      context,
      branch,
      skills_used: skillsUsed,
      automations,
      errors,
      cursors: {
        messages: nextCursor,
        events: this.latestEventCursor(),
      },
      generated_at: now,
      updated_at:
        latestTurnView?.updated_at ??
        latestMessage?.updated_at ??
        session.updated_at,
    };
  }

  private listActiveWorkStreams(
    sessionId: string,
    runtimeSessionId = sessionHintForRow(sessionId),
    currentTurnId?: string,
  ): SessionView["work_streams"] {
    const workStreamStore = new WorkStreamStore(this.butlerData);
    const seenWorkStreams = new Set<string>();
    return [
      ...workStreamStore.listActive({ sessionId, currentTurnId }),
      ...workStreamStore.listActive({
        sessionId: runtimeSessionId,
        currentTurnId,
      }),
    ]
      .map((stream) => workStreamStore.read(stream.id))
      .filter((stream): stream is NonNullable<typeof stream> => Boolean(stream))
      .filter((stream) => appWorkStreamVisibleInActiveProjection(stream, currentTurnId))
      .filter((stream) => {
        if (seenWorkStreams.has(stream.id)) return false;
        seenWorkStreams.add(stream.id);
        return true;
      })
      .slice(0, 10)
      .map((stream) => ({
        id: stream.id,
        title: stream.title,
        owner_session_id: stream.owner_session_id ?? undefined,
        project_id: stream.project_id ?? undefined,
        state: stream.state,
        current_phase: stream.current_phase ?? undefined,
        active_step_id: stream.active_step_id ?? undefined,
        todo_list_id: stream.todo_list_id ?? undefined,
        terminal: workStreamTerminal(stream.state),
        updated_at: stream.updated_at,
      }));
  }

  listArtifacts(sessionId: string): SessionArtifactSummary[] {
    this.ensureChat(sessionId);
    return this.listMessages(sessionId)
      .flatMap((message) => message.artifacts ?? [])
      .slice(-20);
  }

  exportTranscript(sessionId: string): TranscriptExportView {
    const session = this.getSession(sessionId);
    const messages = this.listMessages(sessionId).filter(
      (message) =>
        message.role === "user" ||
        message.role === "assistant" ||
        message.role === "automation" ||
        message.role === "system_event",
    );
    const lines = [
      `# ${session.title}`,
      "",
      `Session: ${session.kind}`,
      `Generated: ${new Date().toISOString()}`,
      "",
      ...messages.flatMap((message) => [
        `## ${message.role}`,
        "",
        message.text,
        "",
      ]),
    ];
    return {
      session_id: sessionId,
      format: "markdown",
      filename: `${safeLocalSessionId(session.title)}.md`,
      content: lines.join("\n"),
      message_count: messages.length,
      generated_at: new Date().toISOString(),
    };
  }

  listAutomations(
    options: { targetSessionId?: string } = {},
  ): AutomationListView {
    const clauses = ["state != 'deleted'"];
    const params: string[] = [];
    if (options.targetSessionId) {
      clauses.push("target_session_id = ?");
      params.push(options.targetSessionId);
    }
    const rows = this.db
      .query<AutomationRow, string[]>(
        `
      SELECT id, title, prompt_body, target_kind, target_session_id, interval_seconds, state,
        next_run_at, last_run_at, last_run_state, last_safe_error_code,
        run_count, consecutive_failure_count, created_at, updated_at
      FROM app_automations
      WHERE ${clauses.join(" AND ")}
      ORDER BY updated_at DESC
      LIMIT 200
    `,
      )
      .all(...params);
    return {
      automations: rows.map((row) =>
        automationSummaryFromRow(
          row,
          this.safeSessionLabel(row.target_session_id),
        ),
      ),
    };
  }

  getAutomation(automationId: string): AutomationDetailView {
    const row = this.getAutomationRow(automationId);
    if (!row || row.state === "deleted") {
      throw new AppStoreOperationError(
        404,
        "automation_not_found",
        "Automation not found.",
      );
    }
    return {
      automation: automationDetailFromRow(
        row,
        this.safeSessionLabel(row.target_session_id),
      ),
    };
  }

  createAutomation(input: CreateAutomationRequest): AutomationMutationResult {
    const title = input.title.trim();
    const prompt = input.prompt_body.trim();
    if (!title)
      throw new AppStoreOperationError(
        400,
        "automation_title_required",
        "Automation title is required.",
      );
    if (!prompt)
      throw new AppStoreOperationError(
        400,
        "automation_prompt_required",
        "Automation prompt is required.",
      );
    const session = this.getSession(input.target_session_id.trim());
    const intervalSeconds = normalizeAutomationInterval(input.interval_seconds);
    const now = new Date();
    const id = `automation-${crypto.randomUUID()}`;
    this.db
      .query(
        `
      INSERT INTO app_automations (
        id, title, prompt_body, target_kind, target_session_id, interval_seconds, state,
        next_run_at, last_run_at, last_run_state, last_safe_error_code,
        run_count, consecutive_failure_count, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, 'enabled', ?, NULL, 'never_run', NULL, 0, 0, ?, ?)
    `,
      )
      .run(
        id,
        title,
        prompt,
        session.kind,
        session.id,
        intervalSeconds,
        new Date(now.getTime() + intervalSeconds * 1000).toISOString(),
        now.toISOString(),
        now.toISOString(),
      );
    const automation = this.getAutomation(id).automation;
    this.appendEvent("automation.created", {
      automation: automationSummaryWithoutPrompt(automation),
    });
    return { automation };
  }

  updateAutomation(
    automationId: string,
    input: UpdateAutomationRequest,
  ): AutomationMutationResult {
    const row = this.getAutomationRow(automationId);
    if (!row || row.state === "deleted") {
      throw new AppStoreOperationError(
        404,
        "automation_not_found",
        "Automation not found.",
      );
    }
    const targetSessionId =
      input.target_session_id?.trim() || row.target_session_id;
    const session = this.getSession(targetSessionId);
    const intervalSeconds =
      input.interval_seconds === undefined
        ? row.interval_seconds
        : normalizeAutomationInterval(input.interval_seconds);
    const state = input.state ?? row.state;
    const now = new Date();
    this.db
      .query(
        `
      UPDATE app_automations
      SET title = ?, prompt_body = ?, target_kind = ?, target_session_id = ?,
        interval_seconds = ?, state = ?, next_run_at = ?, updated_at = ?
      WHERE id = ?
    `,
      )
      .run(
        input.title?.trim() || row.title,
        input.prompt_body?.trim() || row.prompt_body,
        session.kind,
        session.id,
        intervalSeconds,
        state,
        state === "enabled"
          ? new Date(now.getTime() + intervalSeconds * 1000).toISOString()
          : row.next_run_at,
        now.toISOString(),
        automationId,
      );
    const automation = this.getAutomation(automationId).automation;
    this.appendEvent("automation.updated", {
      automation: automationSummaryWithoutPrompt(automation),
    });
    return { automation };
  }

  deleteAutomation(automationId: string): AutomationMutationResult {
    const row = this.getAutomationRow(automationId);
    if (!row)
      throw new AppStoreOperationError(
        404,
        "automation_not_found",
        "Automation not found.",
      );
    const now = new Date().toISOString();
    this.db
      .query(
        "UPDATE app_automations SET state = 'deleted', next_run_at = NULL, updated_at = ? WHERE id = ?",
      )
      .run(now, automationId);
    const automation = automationSummaryFromRow(
      { ...row, state: "deleted", next_run_at: null, updated_at: now },
      this.safeSessionLabel(row.target_session_id),
    );
    this.appendEvent("automation.deleted", { automation });
    return { automation };
  }

  pauseAutomation(automationId: string): AutomationMutationResult {
    return this.updateAutomation(automationId, { state: "paused" });
  }

  resumeAutomation(automationId: string): AutomationMutationResult {
    return this.updateAutomation(automationId, { state: "enabled" });
  }

  async runAutomationNow(
    automationId: string,
    responder?: AppMessageResponder,
    options: SendMessageOptions = {},
    trigger: "run_now" | "scheduled" = "run_now",
  ): Promise<AutomationRunResult> {
    const row = this.getAutomationRow(automationId);
    if (!row || row.state === "deleted")
      throw new AppStoreOperationError(
        404,
        "automation_not_found",
        "Automation not found.",
      );
    if (trigger === "scheduled" && row.state !== "enabled") {
      throw new AppStoreOperationError(
        409,
        "automation_not_enabled",
        "Automation is not enabled.",
      );
    }
    const run = await this.executeAutomationRow(
      row,
      trigger,
      responder,
      options,
    );
    const updated = this.getAutomationRow(automationId)!;
    return {
      automation: automationSummaryFromRow(
        updated,
        this.safeSessionLabel(updated.target_session_id),
      ),
      run,
    };
  }

  async dispatchDueAutomations(
    responder?: AppMessageResponder,
    options: SendMessageOptions = {},
    now = new Date(),
  ): Promise<{ runs: AutomationRunSummary[] }> {
    const runs = await this.drainQueuedAutomationRuns(responder, options);
    const rows = this.db
      .query<AutomationRow, [string]>(
        `
      SELECT id, title, prompt_body, target_kind, target_session_id, interval_seconds, state,
        next_run_at, last_run_at, last_run_state, last_safe_error_code,
        run_count, consecutive_failure_count, created_at, updated_at
      FROM app_automations
      WHERE state = 'enabled' AND next_run_at IS NOT NULL AND next_run_at <= ?
      ORDER BY next_run_at ASC
      LIMIT 20
    `,
      )
      .all(now.toISOString());
    for (const row of rows) {
      runs.push(
        await this.executeAutomationRow(
          row,
          "scheduled",
          responder,
          options,
          now,
        ),
      );
    }
    return { runs };
  }

  listAutomationRuns(automationId: string): AutomationRunListView {
    const rows = this.db
      .query<AutomationRunRow, [string]>(
        `
      SELECT rowid, id, automation_id, target_session_id, state, trigger, started_at,
        completed_at, safe_error_code, queued_message_id, turn_id
      FROM app_automation_runs
      WHERE automation_id = ?
      ORDER BY rowid DESC
      LIMIT 50
    `,
      )
      .all(automationId);
    return { runs: rows.map(automationRunFromRow) };
  }

  listAutomationTargets(sessionId: string): AutomationTargetSummary[] {
    return this.listAutomations({ targetSessionId: sessionId }).automations.map(
      (automation) => ({
        automation_id: automation.id,
        title: automation.title,
        state: automation.state,
        interval_label: automation.interval_label,
        next_run_at: automation.next_run_at,
        last_run_state: automation.last_run_state,
        safe_error_code: automation.last_safe_error_code,
      }),
    );
  }

  private reconcileTurnLocalWorkOutcomeForTurn(turn: TurnRecord): void {
    const outcome = turnLocalWorkOutcomeForAppTurn(turn.state);
    if (!outcome) return;
    try {
      applyTurnLocalWorkOutcomeForSession({
        butlerData: this.butlerData,
        sessionId: sessionHintForRow(turn.chat_id),
        turnId: turn.id,
        outcome,
        statusNote: turnLocalWorkOutcomeStatusNote(outcome),
      });
    } catch {
      // Terminal turn projection must stay available even if stale work repair fails.
    }
  }

  private appendTurnAcknowledgedEvent(chatId: string, turnId: string): void {
    this.appendTurnEvent(chatId, turnId, {
      kind: TURN_ACKNOWLEDGED_EVENT_KIND,
      payload: createTurnAcknowledgedPayload({
        safeLabel: "Request received. Preparing the work.",
        transport: "app",
      }),
    });
  }

  private appendTerminalTurnStateChanged(turn: TurnRecord): void {
    this.appendEvent("turn.state_changed", { turn });
    this.reconcileTurnLocalWorkOutcomeForTurn(turn);
  }

  listWorkerActivity(
    options: { sessionId?: string; includeHistory?: boolean } = {},
  ): WorkerActivityListView {
    const linkedWorkerTaskIds = options.sessionId
      ? this.linkedWorkerTaskIdsForSession(options.sessionId)
      : new Set<string>();
    const plannedStore = new PlannedTaskStore(this.butlerData);
    const orchestrationStore = new WorkOrchestrationStore(this.butlerData);
    const keepInactiveLinkedReportingWorker = (worker: WorkerActivitySummary): boolean => {
      return shouldKeepInactiveLinkedReportingWorker({
        worker,
        sessionId: options.sessionId,
        linkedWorkerTaskIds,
        orchestration: worker.orchestration_id
          ? orchestrationStore.read(worker.orchestration_id)
          : null,
      });
    };
    const rawWorkers = new TaskStore(this.butlerData)
      .summaries(200)
      .map((task) => {
        const linkedToSession = linkedWorkerTaskIds.has(task.task_id);
        const linkedPlan =
          task.task_type === "planned"
            ? null
            : plannedStore.findByWorkerTaskId(task.task_id);
        const orchestrationId =
          task.task_type === "planned"
            ? task.task_id
            : linkedPlan?.record.taskId ??
              orchestrationStore.findByWorkerTaskId(task.task_id)?.record.id;
        const worker = workerActivityFromTaskSummary(task, orchestrationId);
        const appChatId = worker.session_id?.startsWith("butler/app-")
          ? this.chatIdForRuntimeSession(worker.session_id)
          : null;
        if (appChatId) return { ...worker, session_id: appChatId };
        if (linkedToSession && options.sessionId && !worker.session_id) {
          return { ...worker, session_id: options.sessionId };
        }
        return worker;
      })
      .filter((worker) =>
        options.includeHistory ||
        isActiveWorkerActivity(worker) ||
        keepInactiveLinkedReportingWorker(worker),
      )
      // Session-scoped UI prefers exact origin sessions and only recovers
      // originless workers when an explicit work-stream link exists.
      .filter(
        (worker) =>
          !options.sessionId ||
          worker.session_id === options.sessionId ||
          (worker.task_id && linkedWorkerTaskIds.has(worker.task_id)),
      );
    const projectedWorkers = relabelWorkerActivities(orderWorkerActivities(
      synthesizeOrchestrationParentActivities({
        workers: rawWorkers,
        orchestrationStore,
        sessionId: options.sessionId,
        includeHistory: options.includeHistory ?? false,
      }),
    ));
    const workers = options.includeHistory
      ? projectedWorkers
      : projectedWorkers.filter((worker) =>
          isActiveWorkerActivity(worker) ||
          keepInactiveLinkedReportingWorker(worker),
        );
    return { workers };
  }

  private linkedWorkerTaskIdsForSession(sessionId: string): Set<string> {
    const runtimeSessionId = sessionHintForRow(sessionId);
    const workStreamStore = new WorkStreamStore(this.butlerData);
    const orchestrationStore = new WorkOrchestrationStore(this.butlerData);
    const workerTaskIds = new Set<string>();
    const seen = new Set<string>();
    for (const stream of [
      ...workStreamStore.list({ sessionId, includeTerminal: true }),
      ...workStreamStore.list({ sessionId: runtimeSessionId, includeTerminal: true }),
    ]) {
      if (seen.has(stream.id)) continue;
      seen.add(stream.id);
      const record = workStreamStore.read(stream.id);
      for (const workerTaskId of record?.linked_worker_task_ids ?? []) {
        workerTaskIds.add(workerTaskId);
      }
      for (const orchestrationId of record?.linked_orchestration_ids ?? []) {
        const orchestration = orchestrationStore.read(orchestrationId);
        for (const orchestrationStream of orchestration?.streams ?? []) {
          if (orchestrationStream.worker_task_id) {
            workerTaskIds.add(orchestrationStream.worker_task_id);
          }
        }
      }
    }
    return workerTaskIds;
  }

  getWorkerActivity(workerId: string): WorkerActivitySummary {
    const worker = this.listWorkerActivity({
      includeHistory: true,
    }).workers.find((item) => item.worker_id === workerId);
    if (!worker)
      throw new AppStoreOperationError(
        404,
        "worker_not_found",
        "Worker activity not found.",
      );
    return worker;
  }

  controlWorkerActivity(
    workerId: string,
    input: WorkerActivityControlRequest,
  ): WorkerActivityControlResult {
    const worker = this.getWorkerActivity(workerId);
    if (!worker.supported_controls.includes(input.action)) {
      throw new AppStoreOperationError(
        409,
        "worker_control_unsupported",
        "Worker control is not supported.",
      );
    }
    if (input.action === "cancel") {
      return this.cancelWorkerActivity(worker);
    }
    const noticeText = `Worker ${worker.worker_display_name} received ${input.action}. What should Butler do next?`;
    const notice = this.insertMessage(
      worker.session_id ?? DEFAULT_CHAT_ID,
      "system_event",
      noticeText,
      "delivered",
    );
    this.appendEvent("main_session_worker_control_notice", {
      worker_id: worker.worker_id,
      action: input.action,
      message_id: notice.id,
    });
    return { worker, notice };
  }

  private cancelWorkerActivity(
    worker: WorkerActivitySummary,
  ): WorkerActivityControlResult {
    const taskId = worker.task_id;
    if (!taskId) {
      throw new AppStoreOperationError(
        409,
        "worker_control_unsupported",
        "Worker has no cancellable task.",
      );
    }
    const taskStore = new TaskStore(this.butlerData);
    const plannedStore = new PlannedTaskStore(this.butlerData);
    const workStreamStore = new WorkStreamStore(this.butlerData);
    const orchestrationStore = new WorkOrchestrationStore(this.butlerData);
    const cancelledTaskIds = new Set<string>();
    const workerTaskIds = new Set<string>();
    const plannedTaskIds = new Set<string>();
    const orchestrationIds = new Set<string>();

    const cancelWorkerTaskId = (workerTaskId: string) => {
      workerTaskIds.add(workerTaskId);
      this.cancelDurableWorkerTask(taskStore, workerTaskId, cancelledTaskIds);
    };
    const collectPlannedWorkers = (planned: PlannedTaskRecord | null) => {
      if (!planned) return;
      plannedTaskIds.add(planned.taskId);
      for (const workerTaskId of workerTaskIdsForPlannedTask(planned)) {
        workerTaskIds.add(workerTaskId);
      }
    };
    const collectOrchestrationWorkers = (
      orchestration: WorkOrchestrationRecord | null,
    ) => {
      if (!orchestration) return;
      orchestrationIds.add(orchestration.id);
      for (const stream of orchestration.streams) {
        if (stream.worker_task_id) workerTaskIds.add(stream.worker_task_id);
      }
    };

    if (worker.activity_kind === "planned") {
      const planned = plannedStore.read(taskId);
      collectPlannedWorkers(planned);
      this.cancelPlannedTask(plannedStore, taskId);
      plannedTaskIds.add(taskId);
    } else {
      cancelWorkerTaskId(taskId);
      const linkedPlan = plannedStore.findByWorkerTaskId(taskId);
      if (linkedPlan) {
        collectPlannedWorkers(linkedPlan.record);
        this.cancelPlannedTask(plannedStore, linkedPlan.record.taskId);
      }
    }

    const linkedStreams = workStreamStore.linkedTo({
      plannedTaskIds: [...plannedTaskIds],
      workerTaskIds: [...workerTaskIds],
    });
    for (const stream of linkedStreams) {
      for (const linkedWorkerTaskId of stream.linked_worker_task_ids) {
        workerTaskIds.add(linkedWorkerTaskId);
      }
      for (const linkedPlannedTaskId of stream.linked_planned_task_ids) {
        plannedTaskIds.add(linkedPlannedTaskId);
        collectPlannedWorkers(plannedStore.read(linkedPlannedTaskId));
      }
      for (const linkedOrchestrationId of stream.linked_orchestration_ids) {
        collectOrchestrationWorkers(orchestrationStore.read(linkedOrchestrationId));
      }
    }
    for (const linkedOrchestrationId of [...orchestrationIds]) {
      const orchestration = orchestrationStore.read(linkedOrchestrationId);
      collectOrchestrationWorkers(orchestration);
      if (orchestration) orchestrationStore.cancel(linkedOrchestrationId);
    }
    for (const linkedPlannedTaskId of [...plannedTaskIds]) {
      this.cancelPlannedTask(plannedStore, linkedPlannedTaskId);
    }
    for (const linkedWorkerTaskId of [...workerTaskIds]) {
      cancelWorkerTaskId(linkedWorkerTaskId);
    }
    workStreamStore.cancelLinked({
      workStreamIds: linkedStreams.map((stream) => stream.id),
      plannedTaskIds: [...plannedTaskIds],
      orchestrationIds: [...orchestrationIds],
      workerTaskIds: [...workerTaskIds],
      statusNote: "Cancelled by user request.",
    });

    const refreshed = this.getWorkerActivity(worker.worker_id);
    this.appendEvent("worker_activity_controlled", {
      worker_id: refreshed.worker_id,
      action: "cancel",
      phase: refreshed.phase,
      task_id: refreshed.task_id,
      orchestration_id: refreshed.orchestration_id,
    });
    return { worker: refreshed };
  }

  private cancelDurableWorkerTask(
    taskStore: TaskStore,
    taskId: string,
    cancelledTaskIds: Set<string>,
  ): void {
    if (cancelledTaskIds.has(taskId)) return;
    cancelledTaskIds.add(taskId);
    const task = taskStore.read(taskId);
    const taskDir = task?.taskDir ?? taskStore.taskDir(taskId);
    this.terminateWorkerProcessGroup(taskDir, taskId);
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "status"), "KILLED\n", "utf8");
    writeWorkerActivityProjection(
      taskDir,
      "cancelled",
      "Cancelled: worker was stopped by user request.",
    );
  }

  private cancelPlannedTask(
    plannedStore: PlannedTaskStore,
    taskId: string,
  ): void {
    const planned = plannedStore.read(taskId);
    const taskDir = planned?.taskDir ?? plannedStore.taskDir(taskId);
    mkdirSync(taskDir, { recursive: true });
    writeWorkerActivityProjection(
      taskDir,
      "cancelled",
      "Cancelled: planned work was stopped by user request.",
    );
    if (
      !planned ||
      planned.status === "CANCELLED" ||
      planned.status === "REPORTED"
    ) {
      writeFileSync(join(taskDir, "status"), "CANCELLED\n", "utf8");
      return;
    }
    try {
      plannedStore.transition(taskId, "CANCELLED");
    } catch {
      writeFileSync(join(taskDir, "status"), "CANCELLED\n", "utf8");
    }
  }

  private terminateWorkerProcessGroup(taskDir: string, taskId: string): void {
    const pgid = parsePositiveInteger(readTextFile(join(taskDir, "pgid")));
    const pid = parsePositiveInteger(readTextFile(join(taskDir, "pid")));
    const targets = pgid ? [-pgid] : pid ? [pid] : [];
    if (targets.length === 0) {
      this.appendEvent("worker_activity_cancel_no_process", {
        task_id: taskId,
      });
      return;
    }

    const signalTargets = (signal: NodeJS.Signals) => {
      for (const target of targets) {
        try {
          process.kill(target, signal);
        } catch (error) {
          if (!isNoSuchProcessError(error)) {
            this.appendEvent("worker_activity_cancel_signal_failed", {
              task_id: taskId,
              signal,
            });
          }
        }
      }
    };

    signalTargets("SIGTERM");
    const killTimer = setTimeout(() => signalTargets("SIGKILL"), 500);
    killTimer.unref?.();
  }

  createSession(input: CreateSessionRequest): CreateSessionResult {
    const kind = input.kind;
    const projectId = kind === "project" ? input.project_id?.trim() : undefined;
    if (kind === "project") {
      if (!projectId) {
        throw new AppStoreOperationError(
          400,
          "project_required",
          "Project session requires a project.",
        );
      }
      if (!this.getProjectRow(projectId)) {
        throw new AppStoreOperationError(
          404,
          "project_not_found",
          "Project not found.",
        );
      }
    }
    const title =
      input.title?.trim() ||
      (kind === "project" ? "New project chat" : "New chat");
    const id = input.session_hint?.trim()
      ? safeLocalSessionId(input.session_hint)
      : `${kind}-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    this.db
      .query(
        `
      INSERT INTO chats (id, title, kind, project_id, pinned, archived, created_at, updated_at)
      VALUES (?, ?, ?, ?, 0, 0, ?, ?)
    `,
      )
      .run(id, title, kind, projectId ?? null, now, now);
    const session = this.getSession(id);
    this.appendEvent("session.created", { session });
    return { session };
  }

  updateSession(
    sessionId: string,
    input: UpdateSessionRequest,
  ): SessionActionResult {
    const current = this.getSession(sessionId);
    const title = input.title?.trim();
    if (input.title !== undefined && !title) {
      throw new AppStoreOperationError(
        400,
        "session_title_required",
        "Session title is required.",
      );
    }
    const nextTitle = title ?? current.title;
    const nextArchived =
      typeof input.archived === "boolean" ? input.archived : current.archived;
    const now = new Date().toISOString();
    this.db
      .query(
        `
      UPDATE chats
      SET title = ?, archived = ?, updated_at = ?
      WHERE id = ?
    `,
      )
      .run(nextTitle, nextArchived ? 1 : 0, now, sessionId);
    const session = this.getSession(sessionId);
    this.appendEvent("session.updated", { session });
    return { session };
  }

  archiveSession(sessionId: string): SessionActionResult {
    return this.updateSession(sessionId, { archived: true });
  }

  deleteSessionPermanent(sessionId: string): SessionActionResult {
    const session = this.getSession(sessionId);
    this.db.query("DELETE FROM chats WHERE id = ?").run(sessionId);
    this.appendEvent("session.permanently_deleted", { session });
    return { session };
  }

  getSession(sessionId: string): SessionSummary {
    const row = this.db
      .query<SessionSummaryRow, [string]>(
        `
      SELECT
        c.id,
        c.kind,
        c.title,
        c.project_id,
        c.created_at,
        c.updated_at,
        (
          SELECT m.text
          FROM messages m
          WHERE m.chat_id = c.id
            AND ${visibleMessageSqlPredicate("m")}
          ORDER BY m.rowid DESC
          LIMIT 1
        ) AS last_message_preview,
        (
          SELECT t.state
          FROM turns t
          WHERE t.chat_id = c.id
          ORDER BY t.rowid DESC
          LIMIT 1
        ) AS active_turn_state,
        (
          SELECT t.safe_status_label
          FROM turns t
          WHERE t.chat_id = c.id
          ORDER BY t.rowid DESC
          LIMIT 1
        ) AS safe_status_label,
        (
          SELECT t.safe_error_code
          FROM turns t
          WHERE t.chat_id = c.id
          ORDER BY t.rowid DESC
          LIMIT 1
        ) AS active_turn_safe_error_code,
        c.pinned,
        c.archived
      FROM chats c
      WHERE c.id = ?
    `,
      )
      .get(sessionId);
    if (!row)
      throw new AppStoreOperationError(
        404,
        "session_not_found",
        "Session not found.",
      );
    return sessionFromRow(row);
  }

  listMessages(chatId = DEFAULT_CHAT_ID, cursor = 0): MessageRecord[] {
    this.ensureChat(chatId);
    const rows = this.db
      .query<MessageRow, [string, number]>(
        `
      SELECT rowid, id, chat_id, turn_id, role, text, status, created_at, updated_at, safe_error_code, retryable
      FROM messages
      WHERE chat_id = ? AND rowid > ? AND ${visibleMessageSqlPredicate()}
      ORDER BY rowid ASC
      LIMIT 200
    `,
      )
      .all(chatId, cursor);
    const messages = rows.map((row) =>
      messageFromRow(row, this.listMessageAttachments(row.id)),
    );
    const compactionMessages =
      cursor === 0 ? this.compactionMarkerMessages(chatId, cursor) : [];
    return [...messages, ...compactionMessages]
      .filter((message) => Number(message.cursor ?? 0) > cursor)
      .sort(
        (left, right) => Number(left.cursor ?? 0) - Number(right.cursor ?? 0),
      )
      .slice(0, 200);
  }

  listTurns(chatId = DEFAULT_CHAT_ID, cursor = 0): TurnRecord[] {
    this.ensureChat(chatId);
    const rows = this.db
      .query<TurnRow, [string, number]>(
        `
      SELECT rowid, id, chat_id, user_message_id, state, safe_status_label, safe_error_code,
        retryable, cancellable, attempt, created_at, updated_at
      FROM turns
      WHERE chat_id = ? AND rowid > ?
      ORDER BY rowid ASC
      LIMIT 200
    `,
      )
      .all(chatId, cursor);
    return rows.map((row) => publicTurnRecord(turnFromRow(row)));
  }

  listTurnProgressSnapshotsForMessages(
    messages: MessageRecord[],
  ): Record<string, TurnProgressSnapshotView> {
    const turnIds = [
      ...new Set(
        messages
          .map((message) => message.turn_id)
          .filter((turnId): turnId is string => Boolean(turnId)),
      ),
    ];
    const snapshots: Record<string, TurnProgressSnapshotView> = {};
    for (const turnId of turnIds) {
      const turn = this.getTurnRow(turnId);
      if (!turn) continue;
      const publicTurn = publicTurnRecord(turnFromRow(turn));
      const rows = progressRowsForTurnState(
        this.listProgressRowsForTurn(turnId),
        turn.state,
      );
      const summary = publicTurnStatusLabel(
        turn.safe_status_label,
        turn.state,
        turn.safe_error_code,
      );
      const delivery = isPublicSuppressedInternalContinuationCode(
        turn.safe_error_code,
      )
        ? {
            delivery_state: publicDeliveryStateForTurnState(publicTurn.state),
            limitations: [],
            limitation_codes: [],
          }
        : publicDeliveryMetadataForProjection(
            this.deliveryMetadataForTurnRecord(publicTurn),
          );
      const publicDelivery = publicAppDeliveryMetadata(delivery);
      snapshots[turnId] = {
        turn_id: turnId,
        ...(summary ? { summary } : {}),
        updated_at: turn.updated_at,
        state: publicTurn.state,
        ...publicDelivery,
        safe_progress_rows: rows,
      };
    }
    return snapshots;
  }

  private sessionViewTurn(
    turn: TurnRecord,
    options: { suppressProgressRows?: boolean } = {},
  ): SessionViewTurn {
    const delivery = publicAppDeliveryMetadata(
      publicDeliveryMetadataForProjection(this.deliveryMetadataForTurnRecord(turn)),
    );
    const progressRows = options.suppressProgressRows
      ? []
      : progressRowsForTurnState(
          this.listProgressRowsForTurn(turn.id),
          turn.state,
        );
    const progressSummary = publicTurnStatusLabel(
      turn.safe_status_label,
      turn.state,
    );
    return {
      id: turn.id,
      state: turn.state,
      delivery_state: delivery.delivery_state,
      limitations: delivery.limitations,
      limitation_codes: delivery.limitation_codes,
      safe_status_label: progressSummary,
      cancellable: turn.cancellable,
      retryable: turn.retryable,
      progress: {
        turn_id: turn.id,
        ...(progressSummary ? { summary: progressSummary } : {}),
        updated_at: turn.updated_at,
        state: turn.state,
        delivery_state: delivery.delivery_state,
        limitations: delivery.limitations,
        limitation_codes: delivery.limitation_codes,
        safe_progress_rows: progressRows,
      },
      created_at: turn.created_at,
      updated_at: turn.updated_at,
    };
  }

  private sessionViewMessages(sessionId: string): MessageRecord[] {
    return this.listMessages(sessionId).map((message) => {
      if (message.role !== "assistant" || !message.turn_id) return message;
      const turn = this.getTurnRow(message.turn_id);
      if (!turn || !isTerminalProgressState(turn.state)) return message;
      const delivery = this.deliveryLimitationMetadataForTurn(message.turn_id);
      const publicDelivery = delivery
        ? publicAppDeliveryMetadata(publicDeliveryMetadataForProjection(delivery))
        : null;
      const workBlocks = workBlocksFromTerminalProgressRows(
        progressRowsForTurnState(
          this.listProgressRowsForTurn(message.turn_id),
          turn.state,
        ),
      );
      if (workBlocks.length === 0 && !publicDelivery) return message;
      return {
        ...message,
        ...(publicDelivery ?? {}),
        ...(workBlocks.length > 0 ? { work_blocks: workBlocks } : {}),
      };
    });
  }

  private deliveryLimitationMetadataForTurn(
    turnId: string,
  ): DeliveryLimitationMetadata | null {
    const rows = this.db
      .query<EventRow, [string]>(
        `
      SELECT id, type, payload_json, created_at
      FROM events
      WHERE type = 'agent.turn_event'
        AND json_extract(payload_json, '$.turn_id') = ?
      ORDER BY id DESC
      LIMIT 500
    `,
      )
      .all(turnId);
    for (const row of rows) {
      const payload = safeParseRecord(row.payload_json);
      if (payload.turn_id !== turnId) continue;
      const event = isRecord(payload.event) ? payload.event : {};
      const eventPayload = isRecord(event.payload) ? event.payload : {};
      const metadata = deliveryLimitationMetadataFromRecord(eventPayload);
      if (metadata) return metadata;
    }
    return null;
  }

  private deliveryMetadataForTurnRecord(turn: TurnRecord): DeliveryLimitationMetadata {
    return this.deliveryLimitationMetadataForTurn(turn.id) ?? {
      delivery_state: publicDeliveryStateForTurnState(turn.state),
      limitation_codes: [],
      limitations: [],
    };
  }

  syncAllAppTransportEvents(): number {
    const rows = this.db
      .query<{ id: string }, []>(
        `
      SELECT c.id
      FROM chats c
      WHERE c.archived = 0
        OR EXISTS (
          SELECT 1
          FROM turns t
          WHERE t.chat_id = c.id
            AND t.state IN ('accepted', 'thinking', 'running', 'waiting_user')
        )
    `,
      )
      .all();
    return rows.reduce(
      (count, row) => count + this.syncAppTransportEventsForChat(row.id),
      0,
    );
  }

  private syncAppTransportEventsForChat(chatId: string): number {
    const sessionId = sessionHintForRow(chatId);
    const transcriptPath = transcriptPathFromDataHome(
      this.butlerData,
      sessionId,
    );
    let stats: ReturnType<typeof statSync>;
    try {
      stats = statSync(transcriptPath);
    } catch {
      this.transcriptSyncSnapshots.delete(sessionId);
      return 0;
    }
    if (!stats.isFile()) {
      this.transcriptSyncSnapshots.delete(sessionId);
      return 0;
    }
    const previous = this.transcriptSyncSnapshots.get(sessionId);
    if (
      previous?.path === transcriptPath &&
      previous.size === stats.size &&
      previous.mtimeMs === stats.mtimeMs
    ) {
      return 0;
    }
    const incrementalStart =
      previous?.path === transcriptPath &&
      previous.size > 0 &&
      previous.size < stats.size
        ? previous.size
        : 0;
    const transcriptChunk =
      incrementalStart > 0
        ? readTranscriptTextRange(transcriptPath, incrementalStart, stats.size)
        : readTranscriptTextRange(transcriptPath, 0, stats.size);
    const text = incrementalStart > 0
      ? `${previous?.trailing ?? ""}${transcriptChunk}`
      : transcriptChunk;
    const parsed = readTranscriptEventsFromText(text);
    let applied = 0;
    for (const event of parsed.events) {
      if (event.transport !== APP_TRANSPORT) continue;
      if (event.kind === "delivery") {
        if (this.projectAppDeliveryEvent(event)) applied += 1;
        continue;
      }
      if (event.kind !== "outbound") continue;
      if (this.projectAppOutboundEvent(chatId, event)) applied += 1;
    }
    this.transcriptSyncSnapshots.set(sessionId, {
      path: transcriptPath,
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      trailing: parsed.trailing,
    });
    return applied;
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
      return this.projectAppWorkerResult(chatId, event, actionId, message);
    }
    const turnId = this.turnIdForAppOutbound(chatId, metadata, message);
    if (!actionId || !turnId) return false;
    const turn = this.getTurnRow(turnId);
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
        this.hasTurnEventKind(turnId, turnEvent.kind);
      if (!alreadyProjectedReceipt) this.appendTurnEvent(chatId, turnId, turnEvent);
      this.markProjectedTransportEvent(actionId, event.eventId, chatId);
      if (!alreadyProjectedReceipt) this.touchChat(chatId);
      return !alreadyProjectedReceipt;
    }
    let terminalRecoverableCorrection = false;
    if (isTerminalTurnState(turn.state)) {
      if (
        !shouldProjectRecoverableLimitedFinalOverTerminalTurn(turn, metadata) ||
        this.recoverableLimitedFinalForFailedQueueDisposition(metadata) !== "accept"
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
      const projected = !this.hasEquivalentProgressSummaryRow(
        turnId,
        progressRow,
      );
      if (projected)
        this.appendProgressSummaryEvent(chatId, turnId, progressRow);
      this.markProjectedTransportEvent(actionId, event.eventId, chatId);
      this.touchChat(chatId);
      return projected;
    }

    if (metadata.kind === "turn_failed") {
      if (this.hasProjectedTransportEvent(actionId)) return false;
      const projected = this.projectAppTurnFailure(
        chatId,
        turnId,
        message,
        metadata,
        event.timestamp,
      );
      this.markProjectedTransportEvent(actionId, event.eventId, chatId);
      return projected;
    }

    if (metadata.kind !== "final_result") return false;
    const queuedFinalProjection = this.queuedFinalProjectionDisposition(metadata);
    if (queuedFinalProjection === "reject") {
      this.markProjectedTransportEvent(actionId, event.eventId, chatId);
      return false;
    }
    if (queuedFinalProjection === "defer") return false;
    const text = sanitizeAppTransportFinalText(message.text);
    const artifacts = artifactRefsFromOutboundMessage(message.artifacts);
    const delivery = deliveryLimitationMetadataFromRecord(metadata);
    const limitedDelivery = delivery?.delivery_state === "delivered_with_limitations";
    const noVisibleReply = metadata.noVisibleReply === true ||
      shouldTreatLimitedFinalAsNoVisible(artifacts, delivery, metadata);
    if (noVisibleReply && hasUnsupportedNoVisibleDeliveryState(metadata, delivery)) {
      this.markProjectedTransportEvent(actionId, event.eventId, chatId);
      return false;
    }
    if (!text && artifacts.length === 0 && !noVisibleReply) return false;
    if (noVisibleReply) {
      this.finalizeResponderLimitedDelivery(chatId, turnId, {
        text: null,
        reason: delivery?.limitations[0] ?? "Internal recovery required.",
        delivery: deliveryStateFromProjectedNoVisibleFinal(delivery),
      });
      this.markProjectedTransportEvent(actionId, event.eventId, chatId);
      this.touchChat(chatId);
      return true;
    }

    const existing = this.getLatestAssistantMessageForTurn(turnId);
    const artifactFiles = this.artifactFilesFromOutbound(
      chatId,
      artifacts,
      existing?.id,
    );
    if (
      existing?.text === text &&
      existing.status === "delivered" &&
      this.getTurn(turnId).state === "delivered" &&
      artifactFiles.length === 0
    ) {
      this.markProjectedTransportEvent(actionId, event.eventId, chatId);
      return false;
    }

    const files = this.createResponderMessageFiles(chatId, artifactFiles);
    if (!this.hasTurnEventKind(turnId, "message.final.started")) {
      this.appendTurnEvent(chatId, turnId, {
        kind: "message.final.started",
        payload: { safeLabel: "Preparing final answer" },
      });
    }
    this.applyGeneratedSessionTitleFromProjection(
      chatId,
      turnId,
      metadata.generatedSessionTitle,
    );
    this.insertOrReplaceAssistantReplies(
      chatId,
      turnId,
      text ? [text] : [],
      files,
    );
    if (
      terminalRecoverableCorrection ||
      !this.hasTurnEventKind(turnId, "message.final.completed")
    ) {
      this.appendTurnEvent(chatId, turnId, {
        kind: "message.final.completed",
        payload: {
          safeLabel: limitedDelivery
            ? "Final answer ready with limitations"
            : "Final answer ready",
          textChars: text.length,
          ...(delivery ?? {}),
        },
      });
    }
    const deliveredTurn = this.updateTurnState(turnId, "delivered", {
      safeStatusLabel: limitedDelivery ? "Delivered with limitations" : "Delivered",
      retryable: false,
      cancellable: false,
      safeErrorCode: null,
    });
    this.appendTerminalTurnStateChanged(deliveredTurn);
    if (
      terminalRecoverableCorrection ||
      !this.hasTurnEventKind(turnId, "turn.completed")
    ) {
      this.appendTurnEvent(chatId, turnId, {
        kind: "turn.completed",
        payload: {
          safeLabel: limitedDelivery ? "Completed with limitations" : "Completed",
          ...(delivery ?? {}),
        },
      });
    }
    this.markProjectedTransportEvent(actionId, event.eventId, chatId);
    this.touchChat(chatId);
    void this.drainQueuedSessionMessages(chatId).catch(() => undefined);
    return true;
  }

  private queuedFinalProjectionDisposition(
    metadata: Record<string, unknown>,
  ): "accept" | "defer" | "reject" {
    const queueId = safeInboundQueueId(metadata.queueId);
    const dispatchClaimId = safeOptionalShortToken(metadata.dispatchClaimId);
    if (!queueId || !dispatchClaimId) return "accept";
    const failed = this.readInboundQueueTerminalRecord("failed", queueId);
    if (failed) {
      return shouldAcceptRecoverableLimitedFinalForFailedQueue(
        metadata,
        failed,
        dispatchClaimId,
      )
        ? "accept"
        : "reject";
    }
    const processed = this.readInboundQueueTerminalRecord("processed", queueId);
    const processedClaimId = terminalClaimId(processed);
    if (!processed) return "defer";
    if (!processedClaimId) return "defer";
    return processedClaimId === dispatchClaimId ? "accept" : "reject";
  }

  private recoverableLimitedFinalForFailedQueueDisposition(
    metadata: Record<string, unknown>,
  ): "accept" | "reject" {
    const queueId = safeInboundQueueId(metadata.queueId);
    const dispatchClaimId = safeOptionalShortToken(metadata.dispatchClaimId);
    if (!queueId || !dispatchClaimId) return "reject";
    const failed = this.readInboundQueueTerminalRecord("failed", queueId);
    if (!failed) return "reject";
    return shouldAcceptRecoverableLimitedFinalForFailedQueue(
      metadata,
      failed,
      dispatchClaimId,
    )
      ? "accept"
      : "reject";
  }

  private readInboundQueueTerminalRecord(
    state: "failed" | "processed",
    queueId: string,
  ): Record<string, unknown> | null {
    try {
      const text = readFileSync(
        join(this.butlerData, "runtime", "inbound-events", state, `${queueId}.json`),
        "utf8",
      );
      const parsed = JSON.parse(text);
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  private applyGeneratedSessionTitleFromProjection(
    chatId: string,
    turnId: string,
    title: unknown,
  ): void {
    if (typeof title !== "string" || !title.trim()) return;
    const turn = this.getTurnRow(turnId);
    const sourceText = turn?.user_message_id
      ? this.getMessageRow(turn.user_message_id)?.text
      : null;
    if (!sourceText) return;
    this.generatedSessionTitleHandler(chatId, sourceText)?.(title);
  }

  private projectAppWorkerResult(
    chatId: string,
    event: TranscriptEvent,
    actionId: string | undefined,
    message: Record<string, unknown>,
  ): boolean {
    if (!actionId || this.hasProjectedTransportEvent(actionId)) return false;
    const text = sanitizeAppTransportFinalText(message.text);
    const artifacts = artifactRefsFromOutboundMessage(message.artifacts);
    if (!text && artifacts.length === 0) return false;
    const files = this.createResponderMessageFiles(
      chatId,
      this.artifactFilesFromOutbound(chatId, artifacts),
    );
    const projected = this.insertMessage(
      chatId,
      "assistant",
      text,
      "delivered",
      {
        attachments: files,
      },
    );
    this.appendEvent("message.created", { message: projected });
    this.markProjectedTransportEvent(actionId, event.eventId, chatId);
    this.touchChat(chatId);
    return true;
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
    const row = this.db
      .query<
        { action_id: string },
        [string]
      >("SELECT action_id FROM projected_transport_events WHERE action_id = ?")
      .get(actionId);
    return Boolean(row);
  }

  private markProjectedTransportEvent(
    actionId: string,
    eventId: string,
    chatId: string,
  ): void {
    this.db
      .query(
        `
      INSERT OR IGNORE INTO projected_transport_events (action_id, event_id, chat_id, created_at)
      VALUES (?, ?, ?, ?)
    `,
      )
      .run(actionId, eventId, chatId, new Date().toISOString());
  }

  private projectAppTurnFailure(
    chatId: string,
    turnId: string,
    message: Record<string, unknown>,
    metadata: Record<string, unknown>,
    eventTimestamp: string,
  ): boolean {
    const turn = this.getTurnRow(turnId);
    if (!turn) return false;
    if (turn.state === "delivered" || turn.state === "cancelled") return false;
    if (turn.state === "retrying" && timestampBefore(eventTimestamp, turn.updated_at)) {
      return false;
    }
    const safeError = projectSafeTurnFailure({ message, metadata });
    const mayProjectLimitedFailure =
      turn.state !== "failed" ||
      turn.safe_error_code === INTERNAL_RECOVERY_REQUIRED_CODE ||
      turn.safe_error_code === "inbound_dispatch_timeout";
    const limitedDelivery = mayProjectLimitedFailure
      ? appLimitedDeliveryForProjectedFailure(safeError)
      : null;
    if (limitedDelivery) {
      this.finalizeResponderLimitedDelivery(chatId, turnId, limitedDelivery);
      this.touchChat(chatId);
      void this.drainQueuedSessionMessages(chatId).catch(() => undefined);
      return true;
    }
    const existing = this.getLatestAssistantMessageForTurn(turnId);
    if (
      turn.state === "failed" &&
      turn.safe_error_code === safeError.code &&
      existing?.status === "failed" &&
      existing.safe_error_code === safeError.code &&
      existing.text === safeError.message
    ) {
      return false;
    }

    const runtimeFault = this.runtimeFaultRecordForTurn(turnId);
    const isRuntimeFault = Boolean(runtimeFault);
    const isRetryableRuntimeFault = runtimeFault?.retryable === true;
    this.upsertAssistantTurnFailure(chatId, turnId, safeError, {
      retryable: isRetryableRuntimeFault,
    });
    if (!this.hasTurnEventKind(turnId, isRuntimeFault ? "runtime.fault" : "turn.failed")) {
      this.appendTurnEvent(chatId, turnId, {
        kind: isRuntimeFault ? "runtime.fault" : "turn.failed",
        payload: runtimeFault ?? safeTurnFailureEventPayload(safeError),
      });
    }
    const failedTurn = this.updateTurnState(turnId, isRuntimeFault ? "runtime_fault" : "failed", {
      safeStatusLabel: isRuntimeFault ? "Runtime fault" : "Failed",
      retryable: isRetryableRuntimeFault,
      cancellable: false,
      safeErrorCode: safeError.code,
    });
    this.appendTerminalTurnStateChanged(failedTurn);
    this.touchChat(chatId);
    void this.drainQueuedSessionMessages(chatId).catch(() => undefined);
    return true;
  }

  private artifactFilesFromOutbound(
    chatId: string,
    artifacts: ArtifactRef[],
    existingMessageId?: string,
  ): AppMessageResponderFile[] {
    const chat = this.getChatRow(chatId);
    const project = chat?.project_id
      ? this.getProjectRow(chat.project_id)
      : null;
    const allowedRoots = [
      this.butlerData,
      project?.workspace_path ?? this.butlerHome,
      join(this.butlerData, "artifacts", "public-data"),
    ].map((root) => resolve(root));
    const files: AppMessageResponderFile[] = [];
    const seen = new Set<string>();
    const existingKeys = existingMessageId
      ? new Set(
          this.listMessageAttachments(existingMessageId).map((file) =>
            messageFileContentKey(
              file.safe_name,
              file.mime_type,
              file.size_bytes,
              file.sha256,
            ),
          ),
        )
      : new Set<string>();
    for (const artifact of artifacts) {
      const path = this.firstReadableArtifactPath(artifact, allowedRoots, seen);
      if (!path) continue;
      seen.add(path);
      const name = basename(
        artifact.safePathLabel?.trim() || artifact.title || path,
      );
      const bytes = readFileSync(path);
      if (bytes.byteLength === 0) continue;
      const safeName = safeAttachmentName(name);
      const mimeType = normalizeAttachmentMimeType(
        artifact.mimeType ?? mimeTypeForArtifactPath(path),
        safeName,
      );
      const key = messageFileContentKey(
        safeName,
        mimeType,
        bytes.byteLength,
        createHash("sha256").update(bytes).digest("hex"),
      );
      if (existingKeys.has(key)) continue;
      existingKeys.add(key);
      files.push({
        name,
        mimeType,
        bytes,
      });
    }
    return files;
  }

  private firstReadableArtifactPath(
    artifact: ArtifactRef,
    allowedRoots: string[],
    seen: Set<string>,
  ): string | null {
    for (const path of artifactCandidatePaths(artifact, allowedRoots)) {
      if (seen.has(path)) continue;
      if (!allowedRoots.some((root) => isPathInside(root, path))) continue;
      if (!existsSync(path)) continue;
      return path;
    }
    return null;
  }

  getTurn(turnId: string): TurnRecord {
    const row = this.getTurnRow(turnId);
    if (!row)
      throw new AppStoreOperationError(
        404,
        "turn_not_found",
        "Turn not found.",
      );
    return turnFromRow(row);
  }

  replayEvents(cursor = 0): AppEventEnvelope[] {
    this.syncAllAppTransportEvents();
    const rows = this.db
      .query<EventRow, [number]>(
        `
      SELECT id, type, payload_json, created_at
      FROM events
      WHERE id > ?
      ORDER BY id ASC
      LIMIT 200
    `,
      )
      .all(cursor);
    return rows.map((row) => ({
      protocol_version: APP_PROTOCOL_VERSION,
      id: row.id,
      type: row.type,
      created_at: row.created_at,
      payload: publicAppEventPayload(
        row.type,
        JSON.parse(row.payload_json) as Record<string, unknown>,
      ),
    }));
  }

  private latestEventCursor(): number {
    const row = this.db
      .query<{ id: number }, []>(
        `
      SELECT COALESCE(MAX(id), 0) AS id
      FROM events
    `,
      )
      .get();
    return row?.id ?? 0;
  }

  subscribeEvents(listener: (event: AppEventEnvelope) => void): () => void {
    this.eventSubscribers.add(listener);
    return () => {
      this.eventSubscribers.delete(listener);
    };
  }

  appendSafeServerEvent(
    type: string,
    payload: Record<string, unknown>,
  ): AppEventEnvelope {
    return this.appendEvent(type, payload);
  }

  appendTurnEvent(
    sessionId: string,
    turnId: string,
    input: RuntimeTurnEventInput,
  ): AgentTurnEvent {
    const shouldPersist = this.shouldPersistRuntimeTurnEvent(turnId, input.kind);
    const event = createAgentTurnEvent({
      sessionId,
      turnId,
      sessionSequence: this.nextSessionTurnEventSequence(sessionId),
      turnSequence: this.nextTurnEventSequence(turnId),
      kind: input.kind,
      visibility: input.visibility,
      payload: input.payload,
      createdAt: input.createdAt,
    });
    if (!shouldPersist || event.visibility !== "public") return event;
    this.appendEvent("agent.turn_event", {
      session_id: sessionId,
      turn_id: turnId,
      event,
    });
    const progressRow = progressRowFromTurnEvent(event);
    if (progressRow) {
      const row = normalizeProgressSummaryRow(progressRow);
      this.updateActiveTurnProgressSummary(turnId, row);
      this.appendEvent("agent.turn_event.progress", {
        session_id: sessionId,
        turn_id: turnId,
        row,
        event_id: event.id,
      });
    }
    return event;
  }

  private appendProgressSummaryEvent(
    sessionId: string,
    turnId: string,
    input: ProgressSummaryInput,
  ): ProgressSummaryRow {
    const row = normalizeProgressSummaryRow(input);
    if (this.isTerminalTurn(turnId)) return row;
    this.updateActiveTurnProgressSummary(turnId, row);
    const event = turnEventFromProgressRow({
      sessionId,
      turnId,
      row,
      sessionSequence: this.nextSessionTurnEventSequence(sessionId),
      turnSequence: this.nextTurnEventSequence(turnId),
    });
    this.appendEvent("agent.turn_event", {
      session_id: sessionId,
      turn_id: turnId,
      event,
    });
    this.appendEvent("progress.summary", {
      session_id: sessionId,
      turn_id: turnId,
      row,
    });
    return row;
  }

  private updateActiveTurnProgressSummary(
    turnId: string,
    row: ProgressSummaryRow,
  ): void {
    if (isTerminalProgressState(row.state)) return;
    const label = progressSummaryStatusLabel(row);
    if (!label) return;
    this.db
      .query(
        `
      UPDATE turns
      SET safe_status_label = ?, updated_at = ?
      WHERE id = ?
        AND state NOT IN ('delivered', 'failed', 'cancelled')
    `,
      )
      .run(label, row.created_at ?? new Date().toISOString(), turnId);
  }

  private listProgressRowsForTurn(turnId: string): ProgressSummaryRow[] {
    const internalContinuationEventIds =
      this.internalContinuationProgressEventIds(turnId);
    const rows = this.db
      .query<EventRow, [string]>(
        `
      SELECT id, type, payload_json, created_at
      FROM events
      WHERE type IN ('progress.summary', 'agent.turn_event.progress')
        AND json_extract(payload_json, '$.turn_id') = ?
      ORDER BY id DESC
      LIMIT 1000
    `,
      )
      .all(turnId);
    const progressRows: ProgressSummaryRow[] = [];
    for (const event of rows.reverse()) {
      const payload = safeParseRecord(event.payload_json);
      if (payload.turn_id !== turnId) continue;
      const eventId = safeOptionalShortToken(payload.event_id);
      if (
        event.type === "agent.turn_event.progress" &&
        eventId &&
        internalContinuationEventIds.has(eventId)
      ) {
        continue;
      }
      const row = payload.row;
      if (!isRecord(row)) continue;
      progressRows.push(normalizeProgressSummaryRow(row));
    }
    const turn = this.getTurnRow(turnId);
    return publicProgressRowsForTurn(progressRows, turn?.state);
  }

  private internalContinuationProgressEventIds(
    turnId: string,
  ): Set<string> {
    const rows = this.db
      .query<EventRow, [string]>(
        `
      SELECT id, type, payload_json, created_at
      FROM events
      WHERE type = 'agent.turn_event'
        AND json_extract(payload_json, '$.turn_id') = ?
      ORDER BY id DESC
      LIMIT 1000
    `,
      )
      .all(turnId);
    const eventIds = new Set<string>();
    for (const row of rows) {
      const payload = safeParseRecord(row.payload_json);
      if (payload.turn_id !== turnId) continue;
      const event = isRecord(payload.event) ? payload.event : null;
      const eventId = safeOptionalShortToken(event?.id);
      if (eventId && isInternalContinuationProgressEvent(event)) {
        eventIds.add(eventId);
      }
    }
    return eventIds;
  }

  createMessageFile(input: {
    ownerSessionId?: string;
    name: string;
    mimeType?: string;
    bytes: Uint8Array | ArrayBuffer | string;
    allowGeneric?: boolean;
  }): MessageFileUploadResult {
    const ownerSessionId = input.ownerSessionId?.trim() || null;
    if (ownerSessionId) this.ensureChat(ownerSessionId);
    const bytes = normalizeFileBytes(input.bytes);
    if (bytes.byteLength === 0) {
      throw new AppStoreOperationError(
        400,
        "message_file_empty",
        "Attachment file is empty.",
      );
    }
    if (bytes.byteLength > MESSAGE_FILE_MAX_BYTES) {
      throw new AppStoreOperationError(
        413,
        "message_file_too_large",
        "Attachment file is too large.",
      );
    }
    const safeName = safeAttachmentName(input.name);
    const mimeType = normalizeAttachmentMimeType(input.mimeType, safeName);
    const kind = classifyMessageFileKind(
      mimeType,
      safeName,
      Boolean(input.allowGeneric),
    );
    if (!kind) {
      throw new AppStoreOperationError(
        415,
        "message_file_unsupported_type",
        "Attachment file type is not supported.",
      );
    }
    const id = `file-${crypto.randomUUID()}`;
    const storageName = id;
    const createdAt = new Date().toISOString();
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    mkdirSync(this.messageFileRoot(), { recursive: true });
    writeFileSync(join(this.messageFileRoot(), storageName), bytes);
    this.db
      .query(
        `
      INSERT INTO message_files (
        id, owner_session_id, message_id, kind, mime_type, safe_name,
        size_bytes, sha256, storage_name, created_at
      )
      VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        id,
        ownerSessionId,
        kind,
        mimeType,
        safeName,
        bytes.byteLength,
        sha256,
        storageName,
        createdAt,
      );
    const row = this.getMessageFileRow(id);
    if (!row) throw new Error(`Failed to create message file: ${id}`);
    return { file: messageFileRefFromRow(row) };
  }

  getMessageFileDownload(fileId: string): {
    file: MessageFileRef;
    bytes: Buffer;
  } {
    if (!MESSAGE_FILE_ID_PATTERN.test(fileId)) {
      throw new AppStoreOperationError(
        404,
        "message_file_not_found",
        "Attachment file not found.",
      );
    }
    const row = this.getMessageFileRow(fileId);
    if (!row)
      throw new AppStoreOperationError(
        404,
        "message_file_not_found",
        "Attachment file not found.",
      );
    if (
      row.storage_name !== row.id ||
      !MESSAGE_FILE_ID_PATTERN.test(row.storage_name)
    ) {
      throw new AppStoreOperationError(
        404,
        "message_file_not_found",
        "Attachment file not found.",
      );
    }
    const root = this.messageFileRoot();
    const filePath = resolve(root, row.storage_name);
    if (!filePath.startsWith(`${root}${sep}`)) {
      throw new AppStoreOperationError(
        404,
        "message_file_not_found",
        "Attachment file not found.",
      );
    }
    return {
      file: messageFileRefFromRow(row),
      bytes: readFileSync(filePath),
    };
  }

  listSessionQueue(sessionId = DEFAULT_CHAT_ID): SessionQueueView {
    this.ensureChat(sessionId);
    const rows = this.db
      .query<QueuedMessageRow, [string]>(
        `
      SELECT rowid, id, chat_id, text, controls_json, attachments_json, state,
        safe_error_code, dispatched_message_id, turn_id, created_at, updated_at
      FROM session_queued_messages
      WHERE chat_id = ? AND state = 'queued'
      ORDER BY rowid ASC
    `,
      )
      .all(sessionId);
    return {
      session_id: sessionId,
      queued_messages: rows.map((row) => this.queuedMessageFromRow(row)),
    };
  }

  createQueuedMessage(input: QueueMessageRequest): SessionQueueView {
    const chatId = input.chat_id?.trim() || DEFAULT_CHAT_ID;
    this.ensureChat(chatId);
    const text = (input.text ?? "").trim();
    const attachableFiles = this.validateAttachableMessageFiles(
      chatId,
      input.attachments ?? [],
    );
    if (!text && attachableFiles.length === 0) {
      throw new AppStoreOperationError(
        400,
        "empty_queued_message",
        "Queued message text is required.",
      );
    }
    const controls = this.controlsForMessageSend(chatId, input);
    const now = new Date().toISOString();
    const queuedId = `queued-${crypto.randomUUID()}`;
    this.db
      .query(
        `
      INSERT INTO session_queued_messages (
        id, chat_id, text, controls_json, attachments_json, state,
        safe_error_code, dispatched_message_id, turn_id, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, 'queued', NULL, NULL, NULL, ?, ?)
    `,
      )
      .run(
        queuedId,
        chatId,
        text,
        JSON.stringify(controls),
        JSON.stringify(attachableFiles.map((file) => file.id)),
        now,
        now,
      );
    this.appendEvent("session_queue.changed", {
      session_id: chatId,
      queued_message_id: queuedId,
      action: "created",
    });
    return this.listSessionQueue(chatId);
  }

  updateQueuedMessage(
    queuedMessageId: string,
    input: UpdateQueuedMessageRequest,
  ): SessionQueueView {
    const current = this.getQueuedMessageRow(queuedMessageId);
    if (!current || current.state !== "queued") {
      throw new AppStoreOperationError(
        404,
        "queued_message_not_found",
        "Queued message not found.",
      );
    }
    const text =
      typeof input.text === "string" ? input.text.trim() : current.text;
    const attachableFiles =
      input.attachments === undefined
        ? this.queuedMessageFileRows(current)
        : this.validateAttachableMessageFiles(
            current.chat_id,
            input.attachments,
          );
    if (!text && attachableFiles.length === 0) {
      throw new AppStoreOperationError(
        400,
        "empty_queued_message",
        "Queued message text is required.",
      );
    }
    const controls = normalizeSessionControls(
      {
        ...this.queuedControlsFromRow(current),
        model: input.model,
        reasoning_effort: input.reasoning_effort,
        access_mode: input.access_mode,
        plan_mode: input.plan_mode,
      },
      this.registeredModelMetadata(),
    );
    const now = new Date().toISOString();
    this.db
      .query(
        `
      UPDATE session_queued_messages
      SET text = ?, controls_json = ?, attachments_json = ?, updated_at = ?
      WHERE id = ? AND state = 'queued'
    `,
      )
      .run(
        text,
        JSON.stringify(controls),
        JSON.stringify(attachableFiles.map((file) => file.id)),
        now,
        queuedMessageId,
      );
    this.appendEvent("session_queue.changed", {
      session_id: current.chat_id,
      queued_message_id: queuedMessageId,
      action: "updated",
    });
    return this.listSessionQueue(current.chat_id);
  }

  deleteQueuedMessage(queuedMessageId: string): SessionQueueView {
    const current = this.getQueuedMessageRow(queuedMessageId);
    if (!current || current.state !== "queued") {
      throw new AppStoreOperationError(
        404,
        "queued_message_not_found",
        "Queued message not found.",
      );
    }
    const now = new Date().toISOString();
    this.db
      .query(
        `
      UPDATE session_queued_messages
      SET state = 'deleted', updated_at = ?
      WHERE id = ? AND state = 'queued'
    `,
      )
      .run(now, queuedMessageId);
    this.appendEvent("session_queue.changed", {
      session_id: current.chat_id,
      queued_message_id: queuedMessageId,
      action: "deleted",
    });
    return this.listSessionQueue(current.chat_id);
  }

  async sendMessage(
    input: MessageSendRequest,
    responder?: AppMessageResponder,
    options: SendMessageOptions = {},
  ): Promise<MessageSendResult> {
    const chatId = input.chat_id?.trim() || DEFAULT_CHAT_ID;
    this.ensureChat(chatId);
    if (
      input.queue_policy === "enqueue_if_busy" &&
      this.sessionHasActiveTurn(chatId)
    ) {
      const queue = this.createQueuedMessage(input);
      return {
        queued: queue.queued_messages.at(-1),
        replies: [],
        next_cursor: maxMessageCursor(this.listMessages(chatId)),
      };
    }
    const text = (input.text ?? "").trim();
    const attachableFiles = this.validateAttachableMessageFiles(
      chatId,
      input.attachments ?? [],
    );
    const controls = this.controlsForMessageSend(chatId, input);
    const turn = this.insertTurn(chatId, "accepted", "Accepted");
    const accepted = this.insertMessage(chatId, "user", text, "sent", {
      clientMessageId: input.client_message_id,
      turnId: turn.id,
      attachments: attachableFiles,
    });
    this.setTurnUserMessage(turn.id, accepted.id);
    this.appendEvent("message.created", { message: accepted });
    const capturedFeedback = captureUserFeedbackFromMessage({
      butlerData: this.butlerData,
      text,
      messageId: accepted.id,
      turnId: turn.id,
      chatId,
    });
    if (capturedFeedback) {
      this.appendTurnEvent(chatId, turn.id, {
        kind: "cognition.feedback.captured",
        payload: {
          safeLabel: "Feedback captured",
          feedbackId: capturedFeedback.entry.feedback_id,
          category: capturedFeedback.entry.category,
          scope: capturedFeedback.entry.scope,
          targetRef: capturedFeedback.entry.target_ref,
          reason: capturedFeedback.reason,
        },
      });
    }
    this.appendTurnAcknowledgedEvent(chatId, turn.id);
    const thinkingTurn = this.updateTurnState(turn.id, "thinking", {
      safeStatusLabel: "Thinking",
      cancellable: true,
    });
    this.appendEvent("turn.state_changed", { turn: thinkingTurn });

    if (!responder) {
      const queuedTurn = this.enqueueAppTransportTurn({
        chatId,
        turnId: turn.id,
        message: accepted,
        text,
        controls,
      });
      return {
        accepted,
        replies: [],
        turn: queuedTurn,
        next_cursor: accepted.cursor,
      };
    }

    const responderOptions = { ...options, controls };
    if (options.deferResponderTurns) {
      this.dispatchDeferredResponderTurn({
        chatId,
        turnId: turn.id,
        messageId: accepted.id,
        text,
        responder,
        options: responderOptions,
      });
      return {
        accepted,
        replies: [],
        turn: thinkingTurn,
        next_cursor: accepted.cursor,
      };
    }

    const result = await this.completeResponderTurn({
      chatId,
      turnId: turn.id,
      messageId: accepted.id,
      text,
      responder,
      options: responderOptions,
    });
    return { accepted, ...result };
  }

  private dispatchDeferredResponderTurn(input: {
    chatId: string;
    turnId: string;
    messageId: string;
    text: string;
    responder: AppMessageResponder;
    options: SendMessageOptions;
  }): void {
    const options = {
      ...input.options,
      responderTimeoutMs: undefined,
    };
    void this.completeResponderTurn({ ...input, options }).catch(
      () => undefined,
    );
  }

  private async completeResponderTurn(input: {
    chatId: string;
    turnId: string;
    messageId: string;
    text: string;
    responder: AppMessageResponder;
    options: SendMessageOptions;
  }): Promise<{
    reply?: MessageRecord;
    replies: MessageRecord[];
    turn: TurnRecord;
    next_cursor: number;
  }> {
    return await completeResponderTurnLifecycle(input, {
      appendProgress: (row) =>
        this.appendProgressSummaryEvent(input.chatId, input.turnId, row),
      appendTurnEvent: (event) =>
        this.appendTurnEvent(input.chatId, input.turnId, event),
      cleanupTurnEventSequences: (chatId, turnId) =>
        this.cleanupTurnEventSequences(chatId, turnId),
      createResponderMessageFiles: (chatId, files) =>
        this.createResponderMessageFiles(chatId, files ?? []),
      drainQueuedSessionMessages: (chatId, responder, options) =>
        this.drainQueuedSessionMessages(chatId, responder, options),
      finalizeResponderLimitedDelivery: (chatId, turnId, limitedDelivery) =>
        this.finalizeResponderLimitedDelivery(chatId, turnId, limitedDelivery),
      markResponderNonPublicContinuation: (chatId, turnId) =>
        this.markResponderNonPublicContinuation(chatId, turnId),
      finalizeCancelledTurn: (chatId, turnId) =>
        this.finalizeCancelledTurn(chatId, turnId),
      hasTurnEventKind: (turnId, kind) => this.hasTurnEventKind(turnId, kind),
      insertOrReplaceAssistantReplies: (chatId, turnId, texts, files) =>
        this.insertOrReplaceAssistantReplies(chatId, turnId, texts, files),
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
        this.runResponder(
          chatId,
          turnId,
          messageId,
          text,
          responder,
          options,
          onProgress,
          onTurnEvent,
        ),
      touchChat: (chatId) => this.touchChat(chatId),
      updateTurnDelivered: (turnId, delivery) => {
        const limitedDelivery = delivery?.delivery_state === "delivered_with_limitations";
        const deliveredTurn = this.updateTurnState(turnId, "delivered", {
          safeStatusLabel: limitedDelivery ? "Delivered with limitations" : "Delivered",
          retryable: false,
          cancellable: false,
          safeErrorCode: null,
        });
        this.appendTerminalTurnStateChanged(deliveredTurn);
        return deliveredTurn;
      },
      updateTurnFailed: (chatId, turnId, safeError) => {
        const runtimeFault = this.runtimeFaultRecordForTurn(turnId);
        const isRuntimeFault = Boolean(runtimeFault);
        const isRetryableRuntimeFault = runtimeFault?.retryable === true;
        this.upsertAssistantTurnFailure(chatId, turnId, safeError, {
          retryable: isRetryableRuntimeFault,
        });
        if (!this.hasTurnEventKind(turnId, isRuntimeFault ? "runtime.fault" : "turn.failed")) {
          this.appendTurnEvent(chatId, turnId, {
            kind: isRuntimeFault ? "runtime.fault" : "turn.failed",
            payload: runtimeFault ?? safeTurnFailureEventPayload(safeError),
          });
        }
        const failedTurn = this.updateTurnState(turnId, isRuntimeFault ? "runtime_fault" : "failed", {
          safeStatusLabel: isRuntimeFault ? "Runtime fault" : "Failed",
          retryable: isRetryableRuntimeFault,
          cancellable: false,
          safeErrorCode: safeError.code,
        });
        this.appendTerminalTurnStateChanged(failedTurn);
        return failedTurn;
      },
    });
  }

  private enqueueAppTransportTurn(input: {
    chatId: string;
    turnId: string;
    message: MessageRecord;
    text: string;
    controls: SessionControlState;
  }): TurnRecord {
    try {
      this.assertAppTransportExecutorReady();
      const chat = this.getChatRow(input.chatId);
      const project = chat?.project_id
        ? this.getProjectRow(chat.project_id)
        : null;
      const sessionId = sessionHintForRow(input.chatId);
      this.ensureAppTransportSessionBinding({
        chatId: input.chatId,
        sessionId,
        project,
        sessionKind: chat?.kind ?? "chat",
        controls: input.controls,
      });
      const queued = this.serviceClient.enqueueAppTurn(
        {
          chatId: input.chatId,
          messageId: input.message.id,
          turnId: input.turnId,
          text: input.text,
          timestamp: input.message.created_at,
          sessionId,
          accountId: APP_ACCOUNT,
          peerKind: "dm",
          senderId: APP_SENDER_ID,
          senderDisplayName: "Butler App",
          projectId: chat?.project_id ?? undefined,
          attachments: this.listMessageAttachmentsForTransport(input.message.id),
          rawSource: "app-server",
        },
        {
          source: "app-server",
          chatId: input.chatId,
          turnId: input.turnId,
        },
      );
      this.appendEvent("turn.queued", {
        session_id: input.chatId,
        turn_id: input.turnId,
        transport: APP_TRANSPORT,
        queue_id: queued.queueId,
      });
      return this.getTurn(input.turnId) ?? this.updateTurnState(input.turnId, "thinking", {
        safeStatusLabel: "Thinking",
        cancellable: true,
      });
    } catch (error) {
      return this.failAppTransportQueueHandoff(input, error);
    }
  }

  private assertAppTransportExecutorReady(): void {
    const nativeState = readNativeMainState(
      getNativeMainStatePath(this.butlerData),
    );
    if (nativeState && isPidRunning(nativeState.pid)) {
      return;
    }
    const state = readServiceState(this.butlerData, "butler-main");
    if (state && isPidRunning(state.pid)) {
      return;
    }
    if (nativeState) {
      throw new Error(`Butler Agent executor is stale (pid ${nativeState.pid}).`);
    }
    if (state) {
      throw new Error(`Butler Agent executor is stale (pid ${state.pid}).`);
    }
  }

  private failAppTransportQueueHandoff(
    input: {
      chatId: string;
      turnId: string;
    },
    error: unknown,
  ): TurnRecord {
    const safeError = appSafeResponderError(error);
    this.appendTurnEvent(input.chatId, input.turnId, {
      kind: "turn.failed",
      payload: safeTurnFailureEventPayload({
        code: APP_TURN_QUEUE_FAILED_CODE,
        message:
          "Butler could not queue this request for execution. Retry the turn.",
        cause: safeError.cause ?? safeError.message,
      }),
    });
    const failedTurn = this.updateTurnState(input.turnId, "failed", {
      safeStatusLabel: "Failed",
      retryable: false,
      cancellable: false,
      safeErrorCode: APP_TURN_QUEUE_FAILED_CODE,
    });
    this.appendTerminalTurnStateChanged(failedTurn);
    this.appendEvent("turn.queue_failed", {
      session_id: input.chatId,
      turn_id: input.turnId,
      transport: APP_TRANSPORT,
      safe_error_code: APP_TURN_QUEUE_FAILED_CODE,
    });
    return failedTurn;
  }

  private ensureAppTransportSessionBinding(input: {
    chatId: string;
    sessionId: string;
    project: ProjectRow | null;
    sessionKind: ChatKind;
    controls: SessionControlState;
  }): void {
    const existing = this.sessionBindingStore.getBySessionId(input.sessionId);
    const modelRef = normalizeAppModelRef(
      input.controls.model ?? existing?.modelRef,
    );
    const appBinding: SessionTransportBinding = {
      transport: APP_TRANSPORT,
      accountId: APP_ACCOUNT,
      peerId: input.chatId,
    };
    const transportBindings = mergeTransportBindings([
      ...(existing?.transportBindings ?? []),
      appBinding,
    ]);
    const settings = this.getSettings();
    const runtimePolicy = appRuntimePolicy({
      existing: existing?.metadata?.runtimePolicy,
      accessMode: input.controls.access_mode,
    });
    this.sessionBindingStore.upsert({
      sessionId: input.sessionId,
      role: existing?.role ?? "butler",
      projectId: input.project?.id ?? existing?.projectId,
      workspacePath:
        input.project?.workspace_path ??
        existing?.workspacePath ??
        this.butlerHome,
      runtimeAdapterId: existing?.runtimeAdapterId ?? "native-tool-loop",
      modelProviderId:
        modelRef.split("/", 1)[0] || existing?.modelProviderId || "openai",
      modelRef,
      runtimeSessionRef: existing?.runtimeSessionRef,
      providerThreadRef: existing?.providerThreadRef,
      lifecycleState: "active",
      transportBindings,
      metadata: {
        ...(existing?.metadata ?? {}),
        source: "app-server",
        appSessionKind: input.sessionKind,
        accessMode: input.controls.access_mode,
        requiredNativeTools: stringArray(runtimePolicy.requiredNativeTools),
        required_tools: stringArray(runtimePolicy.required_tools),
        requiredNativeToolProfiles: stringArray(runtimePolicy.requiredNativeToolProfiles),
        runtimePolicy,
        reasoning_effort: input.controls.reasoning_effort,
        workerModelRules: settings.worker_model_rules,
      },
    });
  }

  private async runSystemResponderTurn(
    chatId: string,
    messageId: string,
    text: string,
    responder: AppMessageResponder,
    options: SendMessageOptions = {},
  ): Promise<MessageSendResult> {
    this.ensureChat(chatId);
    const controls = this.getSessionControls(chatId);
    const turn = this.insertTurn(chatId, "accepted", "Accepted");
    this.appendTurnAcknowledgedEvent(chatId, turn.id);
    const thinkingTurn = this.updateTurnState(turn.id, "thinking", {
      safeStatusLabel: "Thinking",
      cancellable: true,
    });
    this.appendEvent("turn.state_changed", { turn: thinkingTurn });

    try {
      const appendProgress = (row: ProgressSummaryInput) =>
        this.appendProgressSummaryEvent(chatId, turn.id, row);
      const appendTurnEvent = (event: RuntimeTurnEventInput) =>
        this.appendTurnEvent(chatId, turn.id, event);
      const response = await this.runResponder(
        chatId,
        turn.id,
        messageId,
        text,
        responder,
        { ...options, controls },
        appendProgress,
        appendTurnEvent,
      );
      for (const row of response.progress ?? []) appendProgress(row);
      if (!this.hasTurnEventKind(turn.id, "message.final.started")) {
        appendTurnEvent({
          kind: "message.final.started",
          payload: { safeLabel: "Preparing final answer" },
        });
      }
      const limitedDelivery = response.delivery?.delivery_state === "delivered_with_limitations"
        ? response.delivery
        : null;
      if (options.suppressAssistantReplies) {
        if (!this.hasTurnEventKind(turn.id, "message.final.completed")) {
          appendTurnEvent({
            kind: "message.final.completed",
            payload: {
              safeLabel: limitedDelivery
                ? "Final answer ready with limitations"
                : "Final answer ready",
              textChars: 0,
              ...(limitedDelivery ?? {}),
            },
          });
        }
        const deliveredTurn = this.updateTurnState(turn.id, "delivered", {
          safeStatusLabel: limitedDelivery ? "Delivered with limitations" : "Delivered",
          retryable: false,
          cancellable: false,
          safeErrorCode: null,
        });
        this.appendTerminalTurnStateChanged(deliveredTurn);
        if (!this.hasTurnEventKind(turn.id, "turn.completed")) {
          appendTurnEvent({
            kind: "turn.completed",
            payload: {
              safeLabel: limitedDelivery ? "Completed with limitations" : "Completed",
              ...(limitedDelivery ?? {}),
            },
          });
        }
        this.touchChat(chatId);
        const accepted = {
          id: messageId,
          chat_id: chatId,
          role: "system_event",
          text: "",
          status: "delivered",
          retryable: false,
          cursor: deliveredTurn.cursor,
          created_at: deliveredTurn.updated_at,
          updated_at: deliveredTurn.updated_at,
        } satisfies MessageRecord;
        return {
          accepted,
          replies: [],
          turn: deliveredTurn,
          next_cursor: deliveredTurn.cursor,
        };
      }
      const responderFiles = this.createResponderMessageFiles(
        chatId,
        response.files ?? [],
      );
      const replies = this.insertOrReplaceAssistantReplies(
        chatId,
        turn.id,
        response.texts,
        responderFiles,
      );
      if (!this.hasTurnEventKind(turn.id, "message.final.completed")) {
        appendTurnEvent({
          kind: "message.final.completed",
          payload: {
            safeLabel: limitedDelivery
              ? "Final answer ready with limitations"
              : "Final answer ready",
            textChars: response.texts.join("\n\n").length,
            ...(limitedDelivery ?? {}),
          },
        });
      }
      const deliveredTurn = this.updateTurnState(turn.id, "delivered", {
        safeStatusLabel: limitedDelivery ? "Delivered with limitations" : "Delivered",
        retryable: false,
        cancellable: false,
        safeErrorCode: null,
      });
      this.appendTerminalTurnStateChanged(deliveredTurn);
      if (!this.hasTurnEventKind(turn.id, "turn.completed")) {
        appendTurnEvent({
          kind: "turn.completed",
          payload: {
            safeLabel: limitedDelivery ? "Completed with limitations" : "Completed",
            ...(limitedDelivery ?? {}),
          },
        });
      }
      this.touchChat(chatId);
      const publicLimitedDelivery = limitedDelivery
        ? publicDeliveryMetadataForProjection(limitedDelivery)
        : null;
      const projectedReplies = limitedDelivery
        ? replies.map((reply) => ({ ...reply, ...publicLimitedDelivery! }))
        : replies;
      const reply = projectedReplies.at(-1)!;
      return {
        accepted: reply,
        reply,
        replies: projectedReplies,
        turn: deliveredTurn,
        next_cursor: reply.cursor,
      };
    } catch (error) {
      if (isResponderCancelError(error)) {
        const cancelledTurn = this.finalizeCancelledTurn(chatId, turn.id);
        const existingMessage = this.getMessageRow(messageId);
        const accepted = existingMessage
          ? messageFromRow(
              existingMessage,
              this.listMessageAttachments(messageId),
            )
          : ({
              id: messageId,
              chat_id: chatId,
              role: "system_event",
              text: "",
              status: "delivered",
              retryable: false,
              cursor: cancelledTurn.cursor,
              created_at: cancelledTurn.updated_at,
              updated_at: cancelledTurn.updated_at,
            } satisfies MessageRecord);
        return {
          accepted,
          replies: [],
          turn: cancelledTurn,
          next_cursor: accepted.cursor,
        };
      }
      if (isNonPublicContinuationDeliveryError(error)) {
        const continuation = this.markResponderNonPublicContinuation(
          chatId,
          turn.id,
        );
        const existingMessage = this.getMessageRow(messageId);
        const accepted = existingMessage
          ? messageFromRow(
              existingMessage,
              this.listMessageAttachments(messageId),
            )
          : ({
              id: messageId,
              chat_id: chatId,
              role: "system_event",
              text: "",
              status: "delivered",
              retryable: false,
              cursor: continuation.turn.cursor,
              created_at: continuation.turn.updated_at,
              updated_at: continuation.turn.updated_at,
            } satisfies MessageRecord);
        this.touchChat(chatId);
        return {
          accepted,
          replies: [],
          turn: continuation.turn,
          next_cursor: continuation.turn.cursor,
        };
      }
      const limitedDelivery = appLimitedDeliveryForError(error);
      if (limitedDelivery) {
        const delivered = this.finalizeResponderLimitedDelivery(chatId, turn.id, limitedDelivery);
        const existingMessage = this.getMessageRow(messageId);
        const accepted = existingMessage
          ? messageFromRow(
              existingMessage,
              this.listMessageAttachments(messageId),
            )
          : ({
              id: messageId,
              chat_id: chatId,
              role: "system_event",
              text: "",
              status: "delivered",
              retryable: false,
              cursor: delivered.turn.cursor,
              created_at: delivered.turn.updated_at,
              updated_at: delivered.turn.updated_at,
            } satisfies MessageRecord);
        this.touchChat(chatId);
        return {
          accepted,
          reply: delivered.reply,
          replies: delivered.replies,
          turn: delivered.turn,
          next_cursor: delivered.reply?.cursor ?? delivered.turn.cursor,
        };
      }
      const safeError = appSafeResponderError(error);
      const runtimeFault = this.runtimeFaultRecordForTurn(turn.id);
      const isRuntimeFault = Boolean(runtimeFault);
      const isRetryableRuntimeFault = runtimeFault?.retryable === true;
      this.upsertAssistantTurnFailure(chatId, turn.id, safeError, {
        retryable: isRetryableRuntimeFault,
      });
      if (!this.hasTurnEventKind(turn.id, isRuntimeFault ? "runtime.fault" : "turn.failed")) {
        this.appendTurnEvent(chatId, turn.id, {
          kind: isRuntimeFault ? "runtime.fault" : "turn.failed",
          payload: runtimeFault ?? {
            safeLabel: safeError.message,
            safeErrorCode: safeError.code,
          },
        });
      }
      const failedTurn = this.updateTurnState(turn.id, isRuntimeFault ? "runtime_fault" : "failed", {
        safeStatusLabel: isRuntimeFault ? "Runtime fault" : "Failed",
        retryable: isRetryableRuntimeFault,
        cancellable: false,
        safeErrorCode: safeError.code,
      });
      this.appendTerminalTurnStateChanged(failedTurn);
      this.touchChat(chatId);
      throw error;
    } finally {
      this.cleanupTurnEventSequences(chatId, turn.id);
    }
  }

  private scheduleSystemResponderTurn(input: {
    key: string;
    chatId: string;
    text: string;
    responder: AppMessageResponder;
    options?: SendMessageOptions;
    onSuccess?: () => void;
  }): boolean {
    if (this.pendingSystemResponderTurns.has(input.key)) return false;
    this.pendingSystemResponderTurns.add(input.key);
    void this.runSystemResponderTurn(
      input.chatId,
      input.key,
      input.text,
      input.responder,
      input.options,
    )
      .then(() => {
        input.onSuccess?.();
      })
      .catch((error) => {
        const safeError = appSafeResponderError(error);
        this.appendEvent("worker.app_responder_turn_failed", {
          key: input.key,
          chat_id: input.chatId,
          safe_error_code: safeError.code,
        });
      })
      .finally(() => {
        this.pendingSystemResponderTurns.delete(input.key);
      });
    return true;
  }

  async retryTurn(
    turnId: string,
    responder?: AppMessageResponder,
    options: SendMessageOptions = {},
  ): Promise<TurnActionResult> {
    const row = this.getTurnRow(turnId);
    if (!row)
      throw new AppStoreOperationError(
        404,
        "turn_not_found",
        "Turn not found.",
      );
    if (
      !row.retryable ||
      row.state !== "runtime_fault" ||
      this.runtimeFaultRecordForTurn(turnId)?.retryable !== true
    ) {
      throw new AppStoreOperationError(
        409,
        "turn_not_retryable",
        "Turn is not retryable.",
      );
    }
    if (!row.user_message_id) {
      throw new AppStoreOperationError(
        409,
        "turn_missing_user_message",
        "Turn cannot be retried.",
      );
    }
    const userMessage = this.getMessageRow(row.user_message_id);
    if (!userMessage)
      throw new AppStoreOperationError(
        409,
        "turn_missing_user_message",
        "Turn cannot be retried.",
      );

    const retryingTurn = this.claimRetryTurn(turnId, row.attempt + 1);
    this.appendEvent("turn.state_changed", { turn: retryingTurn });
    this.deleteAssistantMessagesForTurn(turnId);

    if (!responder) {
      this.enqueueAppTransportTurn({
        chatId: row.chat_id,
        turnId,
        message: messageFromRow(
          userMessage,
          this.listMessageAttachments(userMessage.id),
        ),
        text: userMessage.text,
        controls: this.getSessionControls(row.chat_id),
      });
      return {
        turn: retryingTurn,
        replies: [],
        next_cursor: retryingTurn.cursor,
      };
    }

    const responderOptions = {
      ...options,
      controls: this.getSessionControls(row.chat_id),
    };
    if (options.deferResponderTurns) {
      this.dispatchDeferredResponderTurn({
        chatId: row.chat_id,
        turnId,
        messageId: userMessage.id,
        text: userMessage.text,
        responder,
        options: responderOptions,
      });
      return {
        turn: retryingTurn,
        replies: [],
        next_cursor: retryingTurn.cursor,
      };
    }

    return await this.completeResponderTurn({
      chatId: row.chat_id,
      turnId,
      messageId: userMessage.id,
      text: userMessage.text,
      responder,
      options: responderOptions,
    });
  }

  private async drainQueuedSessionMessages(
    chatId: string,
    responder?: AppMessageResponder,
    options: SendMessageOptions = {},
  ): Promise<void> {
    const rows = this.db
      .query<QueuedMessageRow, [string]>(
        `
      SELECT rowid, id, chat_id, text, controls_json, attachments_json, state,
        safe_error_code, dispatched_message_id, turn_id, created_at, updated_at
      FROM session_queued_messages
      WHERE chat_id = ? AND state = 'queued'
      ORDER BY rowid ASC
      LIMIT 20
    `,
      )
      .all(chatId);
    for (const row of rows) {
      if (this.sessionHasActiveTurn(chatId)) return;
      const now = new Date().toISOString();
      this.db
        .query(
          `
        UPDATE session_queued_messages
        SET state = 'dispatching', updated_at = ?
        WHERE id = ? AND state = 'queued'
      `,
        )
        .run(now, row.id);
      this.appendEvent("session_queue.changed", {
        session_id: chatId,
        queued_message_id: row.id,
        action: "dispatching",
      });
      try {
        const controls = this.queuedControlsFromRow(row);
        const result = await this.sendMessage(
          {
            chat_id: chatId,
            text: row.text,
            client_message_id: `queued-message-${row.id}`,
            model: controls.model,
            reasoning_effort: controls.reasoning_effort,
            access_mode: controls.access_mode,
            plan_mode: controls.plan_mode,
            attachments: this.queuedMessageFileRows(row).map((file) => ({
              file_id: file.id,
            })),
          },
          responder,
          options,
        );
        const dispatchedAt = new Date().toISOString();
        this.db
          .query(
            `
          UPDATE session_queued_messages
          SET state = 'dispatched', dispatched_message_id = ?, turn_id = ?,
            safe_error_code = NULL, updated_at = ?
          WHERE id = ?
        `,
          )
          .run(
            result.accepted?.id ?? null,
            result.turn?.id ?? null,
            dispatchedAt,
            row.id,
          );
        this.appendEvent("session_queue.changed", {
          session_id: chatId,
          queued_message_id: row.id,
          action: "dispatched",
          message_id: result.accepted?.id,
          turn_id: result.turn?.id,
        });
      } catch (error) {
        const safeErrorCode =
          error instanceof AppStoreOperationError
            ? error.code
            : "queued_message_dispatch_failed";
        this.db
          .query(
            `
          UPDATE session_queued_messages
          SET state = 'failed', safe_error_code = ?, updated_at = ?
          WHERE id = ?
        `,
          )
          .run(safeErrorCode, new Date().toISOString(), row.id);
        this.appendEvent("session_queue.changed", {
          session_id: chatId,
          queued_message_id: row.id,
          action: "failed",
          safe_error_code: safeErrorCode,
        });
      }
    }
  }

  cancelTurn(turnId: string): TurnActionResult {
    const row = this.getTurnRow(turnId);
    if (!row)
      throw new AppStoreOperationError(
        404,
        "turn_not_found",
        "Turn not found.",
      );
    if (
      !row.cancellable ||
      ["cancelled", "delivered", "failed"].includes(row.state)
    ) {
      throw new AppStoreOperationError(
        409,
        "turn_not_cancellable",
        "Turn is not cancellable.",
      );
    }
    this.activeTurnControllers.get(turnId)?.abort();
    const cancelledTurn = this.finalizeCancelledTurn(row.chat_id, turnId);
    this.cleanupTurnEventSequences(row.chat_id, turnId);
    return {
      turn: cancelledTurn,
      replies: [],
      next_cursor: 0,
    };
  }

  private async executeAutomationRow(
    row: AutomationRow,
    trigger: "scheduled" | "run_now",
    responder?: AppMessageResponder,
    options: SendMessageOptions = {},
    now = new Date(),
  ): Promise<AutomationRunSummary> {
    let runState: AutomationRunState;
    let safeErrorCode: string | null = null;
    let queuedMessageId: string | null = null;
    let turnId: string | null = null;
    const runId = `automation-run-${crypto.randomUUID()}`;
    const startedAt = now.toISOString();
    this.db
      .query(
        `
      INSERT INTO app_automation_runs (
        id, automation_id, target_session_id, state, trigger, started_at,
        completed_at, safe_error_code, queued_message_id, turn_id
      )
      VALUES (?, ?, ?, 'running', ?, ?, NULL, NULL, NULL, NULL)
    `,
      )
      .run(runId, row.id, row.target_session_id, trigger, startedAt);

    try {
      this.getSession(row.target_session_id);
      if (this.sessionHasActiveTurn(row.target_session_id)) {
        const queued = this.insertMessage(
          row.target_session_id,
          "automation",
          "Automation prompt queued.",
          "pending",
        );
        queuedMessageId = queued.id;
        runState = "queued";
      } else {
        const result = await this.sendMessage(
          {
            chat_id: row.target_session_id,
            text: row.prompt_body,
            client_message_id: `automation-${row.id}-${runId}`,
          },
          responder,
          options,
        );
        if (!result.turn) {
          throw new AppStoreOperationError(
            500,
            "automation_dispatch_failed",
            "Automation dispatch did not start a turn.",
          );
        }
        turnId = result.turn.id;
        runState = "succeeded";
      }
    } catch (error) {
      runState = "failed";
      safeErrorCode =
        error instanceof AppStoreOperationError
          ? error.code
          : "automation_dispatch_failed";
    }

    const completedAt = new Date().toISOString();
    this.db
      .query(
        `
      UPDATE app_automation_runs
      SET state = ?, completed_at = ?, safe_error_code = ?, queued_message_id = ?, turn_id = ?
      WHERE id = ?
    `,
      )
      .run(
        runState,
        completedAt,
        safeErrorCode,
        queuedMessageId,
        turnId,
        runId,
      );

    const nextRunAt =
      row.state === "enabled" && row.interval_seconds > 0
        ? new Date(
            Date.parse(completedAt) + row.interval_seconds * 1000,
          ).toISOString()
        : null;
    this.db
      .query(
        `
      UPDATE app_automations
      SET next_run_at = ?, last_run_at = ?, last_run_state = ?, last_safe_error_code = ?,
        run_count = run_count + 1,
        consecutive_failure_count = ?,
        updated_at = ?
      WHERE id = ?
    `,
      )
      .run(
        row.state === "enabled" ? nextRunAt : row.next_run_at,
        completedAt,
        runState,
        safeErrorCode,
        runState === "failed" ? row.consecutive_failure_count + 1 : 0,
        completedAt,
        row.id,
      );
    const run = this.listAutomationRuns(row.id).runs.find(
      (item) => item.id === runId,
    )!;
    this.appendEvent("automation.run", {
      automation_id: row.id,
      target_session_id: row.target_session_id,
      state: run.state,
      trigger,
      safe_error_code: run.safe_error_code,
    });
    return run;
  }

  private async drainQueuedAutomationRuns(
    responder?: AppMessageResponder,
    options: SendMessageOptions = {},
  ): Promise<AutomationRunSummary[]> {
    const rows = this.db
      .query<QueuedAutomationRunRow, []>(
        `
      SELECT
        r.id AS run_id,
        r.automation_id,
        r.target_session_id,
        r.trigger,
        r.queued_message_id,
        a.title,
        a.prompt_body,
        a.target_kind,
        a.interval_seconds,
        a.state,
        a.next_run_at,
        a.last_run_at,
        a.last_run_state,
        a.last_safe_error_code,
        a.run_count,
        a.consecutive_failure_count,
        a.created_at,
        a.updated_at
      FROM app_automation_runs r
      JOIN app_automations a ON a.id = r.automation_id
      WHERE r.state = 'queued' AND a.state != 'deleted'
      ORDER BY r.rowid ASC
      LIMIT 20
    `,
      )
      .all();
    const runs: AutomationRunSummary[] = [];
    for (const row of rows) {
      if (this.sessionHasActiveTurn(row.target_session_id)) continue;
      runs.push(await this.executeQueuedAutomationRun(row, responder, options));
    }
    return runs;
  }

  private async executeQueuedAutomationRun(
    row: QueuedAutomationRunRow,
    responder?: AppMessageResponder,
    options: SendMessageOptions = {},
  ): Promise<AutomationRunSummary> {
    let runState: AutomationRunState;
    let safeErrorCode: string | null = null;
    let turnId: string | null = null;

    try {
      this.getSession(row.target_session_id);
      const result = await this.sendMessage(
        {
          chat_id: row.target_session_id,
          text: row.prompt_body,
          client_message_id: `automation-${row.automation_id}-${row.run_id}`,
        },
        responder,
        options,
      );
      if (!result.turn) {
        throw new AppStoreOperationError(
          500,
          "automation_dispatch_failed",
          "Automation dispatch did not start a turn.",
        );
      }
      turnId = result.turn.id;
      runState = "succeeded";
      if (row.queued_message_id) {
        const updated = this.updateMessage(row.queued_message_id, {
          text: "Automation prompt dispatched.",
          status: "delivered",
        });
        this.appendEvent("message.updated", { message: updated });
      }
    } catch (error) {
      runState =
        error instanceof AppStoreOperationError &&
        error.code === "session_not_found"
          ? "skipped_target_unavailable"
          : "failed";
      safeErrorCode =
        error instanceof AppStoreOperationError
          ? error.code
          : "automation_dispatch_failed";
      if (row.queued_message_id) {
        const updated = this.updateMessage(row.queued_message_id, {
          text: "Automation prompt could not be dispatched.",
          status: "failed",
          safeErrorCode,
          retryable: true,
        });
        this.appendEvent("message.updated", { message: updated });
      }
    }

    const completedAt = new Date().toISOString();
    this.db
      .query(
        `
      UPDATE app_automation_runs
      SET state = ?, completed_at = ?, safe_error_code = ?, turn_id = ?
      WHERE id = ?
    `,
      )
      .run(runState, completedAt, safeErrorCode, turnId, row.run_id);

    this.db
      .query(
        `
      UPDATE app_automations
      SET last_run_at = ?, last_run_state = ?, last_safe_error_code = ?,
        consecutive_failure_count = ?,
        updated_at = ?
      WHERE id = ?
    `,
      )
      .run(
        completedAt,
        runState,
        safeErrorCode,
        runState === "failed" ? row.consecutive_failure_count + 1 : 0,
        completedAt,
        row.automation_id,
      );
    const run = this.listAutomationRuns(row.automation_id).runs.find(
      (item) => item.id === row.run_id,
    )!;
    this.appendEvent("automation.run", {
      automation_id: row.automation_id,
      target_session_id: row.target_session_id,
      state: run.state,
      trigger: row.trigger,
      safe_error_code: run.safe_error_code,
    });
    return run;
  }

  private sessionHasActiveTurn(sessionId: string): boolean {
    this.reconcileDeliveredSystemResponderTurns(sessionId);
    const row = this.db
      .query<{ state: TurnState }, [string]>(
        `
      SELECT state
      FROM turns
      WHERE chat_id = ?
      ORDER BY rowid DESC
      LIMIT 1
    `,
      )
      .get(sessionId);
    return Boolean(
      row &&
      [
        "accepted",
        "thinking",
        "streaming",
        "waiting_for_form",
        "waiting_for_tool",
        "cancelling",
        "retrying",
      ].includes(row.state),
    );
  }

  private reconcileDeliveredSystemResponderTurns(sessionId: string): void {
    const now = new Date().toISOString();
    this.db
      .query<unknown, [string, string]>(
        `
      UPDATE turns
      SET
        state = 'delivered',
        safe_status_label = 'Delivered',
        safe_error_code = NULL,
        retryable = 0,
        cancellable = 0,
        updated_at = ?
      WHERE chat_id = ?
        AND user_message_id IS NULL
        AND state IN ('accepted', 'thinking', 'streaming', 'waiting_for_form', 'waiting_for_tool', 'cancelling', 'retrying')
        AND EXISTS (
          SELECT 1
          FROM messages
          WHERE messages.chat_id = turns.chat_id
            AND messages.role = 'assistant'
            AND messages.status = 'delivered'
            AND messages.turn_id IS NULL
            AND messages.created_at >= turns.created_at
        )
    `,
      )
      .run(now, sessionId);
  }

  private reconcileCancelledTurnActivityMessages(): void {
    const rows = this.db
      .query<{ id: string; chat_id: string }, [string]>(
        `
      SELECT turns.id, turns.chat_id
      FROM turns
      WHERE turns.state = 'cancelled'
        AND NOT EXISTS (
          SELECT 1
          FROM messages
          WHERE messages.turn_id = turns.id
            AND messages.role = 'assistant'
            AND messages.status = 'cancelled'
            AND messages.text = ?
        )
      ORDER BY turns.rowid ASC
    `,
      )
      .all(CANCELLED_TURN_ACTIVITY_TEXT);
    for (const row of rows) {
      this.ensureCancelledTurnActivityMessage(row.chat_id, row.id);
    }
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chats (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        kind TEXT NOT NULL,
        project_id TEXT,
        pinned INTEGER NOT NULL DEFAULT 0,
        archived INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        status TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        workspace_label TEXT NOT NULL,
        safe_path_label TEXT NOT NULL,
        pinned INTEGER NOT NULL DEFAULT 0,
        archived INTEGER NOT NULL DEFAULT 0,
        error_summary TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        turn_id TEXT,
        role TEXT NOT NULL,
        text TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        safe_error_code TEXT,
        retryable INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS message_files (
        id TEXT PRIMARY KEY,
        owner_session_id TEXT REFERENCES chats(id) ON DELETE SET NULL,
        message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
        kind TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        safe_name TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        storage_name TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS message_attachments (
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        file_id TEXT NOT NULL REFERENCES message_files(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        PRIMARY KEY (message_id, file_id)
      );

      CREATE TABLE IF NOT EXISTS session_queued_messages (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        text TEXT NOT NULL,
        controls_json TEXT NOT NULL,
        attachments_json TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'queued',
        safe_error_code TEXT,
        dispatched_message_id TEXT,
        turn_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS turns (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        user_message_id TEXT,
        state TEXT NOT NULL,
        safe_status_label TEXT NOT NULL,
        safe_error_code TEXT,
        retryable INTEGER NOT NULL DEFAULT 0,
        cancellable INTEGER NOT NULL DEFAULT 0,
        attempt INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS projected_transport_events (
        action_id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS app_automations (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        prompt_body TEXT NOT NULL,
        target_kind TEXT NOT NULL,
        target_session_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        interval_seconds INTEGER NOT NULL,
        state TEXT NOT NULL,
        next_run_at TEXT,
        last_run_at TEXT,
        last_run_state TEXT NOT NULL,
        last_safe_error_code TEXT,
        run_count INTEGER NOT NULL DEFAULT 0,
        consecutive_failure_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS app_automation_runs (
        id TEXT PRIMARY KEY,
        automation_id TEXT NOT NULL REFERENCES app_automations(id) ON DELETE CASCADE,
        target_session_id TEXT NOT NULL,
        state TEXT NOT NULL,
        trigger TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        safe_error_code TEXT,
        queued_message_id TEXT,
        turn_id TEXT
      );

      CREATE UNIQUE INDEX IF NOT EXISTS projects_active_workspace_path_idx
      ON projects(workspace_path)
      WHERE archived = 0;

      CREATE INDEX IF NOT EXISTS app_automations_target_idx
      ON app_automations(target_session_id, state);

      CREATE INDEX IF NOT EXISTS app_automation_runs_automation_idx
      ON app_automation_runs(automation_id);

      CREATE INDEX IF NOT EXISTS message_files_owner_idx
      ON message_files(owner_session_id, message_id);

      CREATE INDEX IF NOT EXISTS message_attachments_message_idx
      ON message_attachments(message_id, position);

      CREATE INDEX IF NOT EXISTS session_queued_messages_session_idx
      ON session_queued_messages(chat_id, state);

      CREATE INDEX IF NOT EXISTS turns_chat_state_idx
      ON turns(chat_id, state);

      CREATE INDEX IF NOT EXISTS events_type_id_idx
      ON events(type, id DESC);

      CREATE INDEX IF NOT EXISTS events_type_turn_id_idx
      ON events(type, json_extract(payload_json, '$.turn_id'), id DESC);

      CREATE INDEX IF NOT EXISTS events_type_session_id_idx
      ON events(type, json_extract(payload_json, '$.session_id'), id DESC);

      CREATE INDEX IF NOT EXISTS events_turn_event_kind_idx
      ON events(type, json_extract(payload_json, '$.turn_id'), json_extract(payload_json, '$.event.kind'), id DESC);
    `);
    ensureAppMessageQuerySchema(this.db);
    this.ensureColumn("chats", "pinned", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("chats", "archived", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("messages", "turn_id", "TEXT");
    this.ensureColumn("messages", "updated_at", "TEXT");
    this.ensureColumn("messages", "safe_error_code", "TEXT");
    this.ensureColumn("messages", "retryable", "INTEGER NOT NULL DEFAULT 0");
    this.db
      .query("UPDATE chats SET kind = 'chat' WHERE kind = 'general'")
      .run();
    this.db
      .query(
        "UPDATE messages SET updated_at = created_at WHERE updated_at IS NULL",
      )
      .run();
  }

  private seedDefaults(): void {
    const now = new Date().toISOString();
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO chats (id, title, kind, project_id, pinned, archived, created_at, updated_at)
      VALUES (?, ?, ?, ?, 0, 0, ?, ?)
    `);
    insert.run(DEFAULT_CHAT_ID, DEFAULT_CHAT_TITLE, "chat", null, now, now);
    this.db
      .query(
        `
      UPDATE chats
      SET title = ?, updated_at = ?
      WHERE id = ?
        AND title = 'New chat'
        AND NOT EXISTS (SELECT 1 FROM messages WHERE messages.chat_id = chats.id)
    `,
      )
      .run(DEFAULT_CHAT_TITLE, now, DEFAULT_CHAT_ID);
    this.removeUnusedSeededButlerProject();
  }

  private removeUnusedSeededButlerProject(): void {
    this.db
      .query(
        `
      DELETE FROM chats
      WHERE id = 'project-butler'
        AND kind = 'project'
        AND project_id = ?
        AND NOT EXISTS (SELECT 1 FROM messages WHERE messages.chat_id = chats.id)
    `,
      )
      .run(DEFAULT_PROJECT_ID);
    this.db
      .query(
        `
      DELETE FROM projects
      WHERE id = ?
        AND display_name = 'butler'
        AND NOT EXISTS (SELECT 1 FROM chats WHERE chats.project_id = projects.id)
    `,
      )
      .run(DEFAULT_PROJECT_ID);
  }

  private ensureChat(chatId: string): void {
    const row = this.db
      .query<{ id: string }, [string]>("SELECT id FROM chats WHERE id = ?")
      .get(chatId);
    if (!row) throw new Error(`Unknown chat: ${chatId}`);
  }

  private insertTurn(
    chatId: string,
    state: TurnState,
    safeStatusLabel: string,
  ): TurnRecord {
    const id = `turn-${crypto.randomUUID()}`;
    const createdAt = new Date().toISOString();
    this.db
      .query(
        `
      INSERT INTO turns (
        id, chat_id, user_message_id, state, safe_status_label, safe_error_code,
        retryable, cancellable, attempt, created_at, updated_at
      )
      VALUES (?, ?, NULL, ?, ?, NULL, 0, 0, 1, ?, ?)
    `,
      )
      .run(id, chatId, state, safeStatusLabel, createdAt, createdAt);
    return this.getTurn(id);
  }

  private setTurnUserMessage(turnId: string, messageId: string): void {
    const now = new Date().toISOString();
    this.db
      .query(
        "UPDATE turns SET user_message_id = ?, updated_at = ? WHERE id = ?",
      )
      .run(messageId, now, turnId);
  }

  private updateTurnState(
    turnId: string,
    state: TurnState,
    options: {
      safeStatusLabel: string;
      safeErrorCode?: string | null;
      retryable?: boolean;
      cancellable?: boolean;
      attempt?: number;
    },
  ): TurnRecord {
    const current = this.getTurnRow(turnId);
    if (!current)
      throw new AppStoreOperationError(
        404,
        "turn_not_found",
        "Turn not found.",
      );
    if (current.state === "cancelled" && state !== "cancelled") {
      return this.getTurn(turnId);
    }
    const now = new Date().toISOString();
    this.db
      .query(
        `
      UPDATE turns
      SET state = ?, safe_status_label = ?, safe_error_code = ?, retryable = ?,
        cancellable = ?, attempt = ?, updated_at = ?
      WHERE id = ?
    `,
      )
      .run(
        state,
        options.safeStatusLabel,
        options.safeErrorCode ?? null,
        (options.retryable ?? false) ? 1 : 0,
        (options.cancellable ?? false) ? 1 : 0,
        options.attempt ?? current.attempt,
        now,
        turnId,
      );
    return this.getTurn(turnId);
  }

  private claimRetryTurn(turnId: string, attempt: number): TurnRecord {
    const now = new Date().toISOString();
    const result = this.db
      .query(
        `
      UPDATE turns
      SET state = 'retrying', safe_status_label = 'Retrying', safe_error_code = NULL,
        retryable = 0, cancellable = 1, attempt = ?, updated_at = ?
      WHERE id = ? AND state = 'runtime_fault' AND retryable = 1
    `,
      )
      .run(attempt, now, turnId) as { changes: number };
    if (result.changes !== 1) {
      throw new AppStoreOperationError(
        409,
        "turn_not_retryable",
        "Turn is not retryable.",
      );
    }
    return this.getTurn(turnId);
  }

  private messageFileRoot(): string {
    return resolve(this.butlerData, "app-server", "message-files");
  }

  private getMessageFileRow(fileId: string): MessageFileRow | null {
    if (!MESSAGE_FILE_ID_PATTERN.test(fileId)) return null;
    return (
      this.db
        .query<MessageFileRow, [string]>(
          `
      SELECT id, owner_session_id, message_id, kind, mime_type, safe_name,
        size_bytes, sha256, storage_name, created_at
      FROM message_files
      WHERE id = ?
    `,
        )
        .get(fileId) ?? null
    );
  }

  private getQueuedMessageRow(
    queuedMessageId: string,
  ): QueuedMessageRow | null {
    return (
      this.db
        .query<QueuedMessageRow, [string]>(
          `
      SELECT rowid, id, chat_id, text, controls_json, attachments_json, state,
        safe_error_code, dispatched_message_id, turn_id, created_at, updated_at
      FROM session_queued_messages
      WHERE id = ?
    `,
        )
        .get(queuedMessageId) ?? null
    );
  }

  private queuedControlsFromRow(row: QueuedMessageRow): SessionControlState {
    try {
      return normalizeSessionControls(
        JSON.parse(row.controls_json) as Partial<SessionControlState>,
        this.registeredModelMetadata(),
      );
    } catch {
      return this.getSessionControls(row.chat_id);
    }
  }

  private queuedMessageFileRows(row: QueuedMessageRow): MessageFileRow[] {
    let ids: string[] = [];
    try {
      const parsed = JSON.parse(row.attachments_json) as unknown;
      if (Array.isArray(parsed)) {
        ids = parsed
          .map((value) => (typeof value === "string" ? value : ""))
          .filter(Boolean);
      }
    } catch {
      ids = [];
    }
    return ids
      .map((fileId) => this.getMessageFileRow(fileId))
      .filter((file): file is MessageFileRow => Boolean(file));
  }

  private queuedMessageFromRow(row: QueuedMessageRow): QueuedMessageRecord {
    const attachments = this.queuedMessageFileRows(row).map(
      messageFileRefFromRow,
    );
    const record: QueuedMessageRecord = {
      id: row.id,
      chat_id: row.chat_id,
      text: row.text,
      controls: this.queuedControlsFromRow(row),
      state: row.state,
      cursor: row.rowid,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
    if (attachments.length > 0) record.attachments = attachments;
    if (row.safe_error_code) record.safe_error_code = row.safe_error_code;
    if (row.dispatched_message_id)
      record.dispatched_message_id = row.dispatched_message_id;
    if (row.turn_id) record.turn_id = row.turn_id;
    return record;
  }

  private listMessageAttachments(messageId: string): MessageFileRef[] {
    const rows = this.db
      .query<MessageFileRow, [string]>(
        `
      SELECT f.id, f.owner_session_id, f.message_id, f.kind, f.mime_type,
        f.safe_name, f.size_bytes, f.sha256, f.storage_name, f.created_at
      FROM message_attachments a
      JOIN message_files f ON f.id = a.file_id
      WHERE a.message_id = ?
      ORDER BY a.position ASC
    `,
      )
      .all(messageId);
    return rows.map(messageFileRefFromRow);
  }

  private listMessageAttachmentsForTransport(
    messageId: string,
  ): AttachmentRef[] {
    const rows = this.db
      .query<MessageFileRow, [string]>(
        `
      SELECT f.id, f.owner_session_id, f.message_id, f.kind, f.mime_type,
        f.safe_name, f.size_bytes, f.sha256, f.storage_name, f.created_at
      FROM message_attachments a
      JOIN message_files f ON f.id = a.file_id
      WHERE a.message_id = ?
      ORDER BY a.position ASC
    `,
      )
      .all(messageId);
    return rows.map((row) => {
      const filePath = resolve(this.messageFileRoot(), row.storage_name);
      return {
        id: row.id,
        kind:
          row.kind === "image"
            ? "image"
            : row.kind === "text"
              ? "document"
              : "binary",
        mimeType: row.mime_type,
        fileName: row.safe_name,
        sizeBytes: row.size_bytes,
        localPath: filePath,
        url: `/message-files/${encodeURIComponent(row.id)}`,
        metadata: {
          source: "message-file-store",
          createdAt: row.created_at,
        },
      };
    });
  }

  private listMessageFilesForSession(sessionId: string): MessageFileRef[] {
    const rows = this.db
      .query<MessageFileRow, [string]>(
        `
      SELECT id, owner_session_id, message_id, kind, mime_type, safe_name,
        size_bytes, sha256, storage_name, created_at
      FROM message_files
      WHERE owner_session_id = ?
      ORDER BY created_at ASC
    `,
      )
      .all(sessionId);
    return rows.map(messageFileRefFromRow);
  }

  private validateAttachableMessageFiles(
    chatId: string,
    attachments: Array<{ file_id?: string }>,
  ): MessageFileRow[] {
    const ids = Array.from(
      new Set(
        attachments
          .map((attachment) => attachment?.file_id?.trim() ?? "")
          .filter(Boolean),
      ),
    );
    if (ids.length > MESSAGE_FILE_MAX_ATTACHMENTS) {
      throw new AppStoreOperationError(
        400,
        "too_many_attachments",
        "Too many attachments.",
      );
    }
    return ids.map((fileId) => {
      const row = this.getMessageFileRow(fileId);
      if (!row) {
        throw new AppStoreOperationError(
          400,
          "message_file_not_found",
          "Attachment file not found.",
        );
      }
      if (row.message_id) {
        throw new AppStoreOperationError(
          409,
          "message_file_already_attached",
          "Attachment file was already sent.",
        );
      }
      if (row.owner_session_id && row.owner_session_id !== chatId) {
        throw new AppStoreOperationError(
          403,
          "message_file_wrong_session",
          "Attachment file belongs to a different session.",
        );
      }
      return row;
    });
  }

  private attachFilesToMessage(
    chatId: string,
    messageId: string,
    files: MessageFileRow[],
  ): void {
    files.forEach((file, index) => {
      this.db
        .query(
          `
        INSERT OR REPLACE INTO message_attachments (message_id, file_id, position)
        VALUES (?, ?, ?)
      `,
        )
        .run(messageId, file.id, index);
      this.db
        .query(
          `
        UPDATE message_files
        SET owner_session_id = ?, message_id = ?
        WHERE id = ?
      `,
        )
        .run(chatId, messageId, file.id);
    });
  }

  private createResponderMessageFiles(
    chatId: string,
    files: AppMessageResponderFile[],
  ): MessageFileRow[] {
    return files.slice(0, MESSAGE_FILE_MAX_ATTACHMENTS).map((file) => {
      const bytes = normalizeFileBytes(file.bytes);
      if (bytes.byteLength === 0) {
        throw new AppStoreOperationError(
          400,
          "message_file_empty",
          "Attachment file is empty.",
        );
      }
      if (bytes.byteLength > MESSAGE_FILE_MAX_BYTES) {
        throw new AppStoreOperationError(
          413,
          "message_file_too_large",
          "Attachment file is too large.",
        );
      }
      const created = this.createMessageFile({
        ownerSessionId: chatId,
        name: file.name,
        mimeType: file.mimeType,
        bytes,
        allowGeneric: true,
      });
      const row = this.getMessageFileRow(created.file.file_id);
      if (!row)
        throw new Error(
          `Failed to load responder file: ${created.file.file_id}`,
        );
      return row;
    });
  }

  private insertMessage(
    chatId: string,
    role: MessageRole,
    text: string,
    status: MessageStatus,
    options: {
      clientMessageId?: string;
      turnId?: string;
      safeErrorCode?: string;
      retryable?: boolean;
      attachments?: MessageFileRow[];
    } = {},
  ): MessageRecord {
    const safeClientId = options.clientMessageId?.trim();
    const id =
      role === "user" &&
      safeClientId &&
      /^client-[0-9a-f-]{36}$/iu.test(safeClientId)
        ? safeClientId
        : `msg-${crypto.randomUUID()}`;
    const createdAt = new Date().toISOString();
    this.db
      .query(
        `
      INSERT INTO messages (id, chat_id, turn_id, role, text, status, created_at, updated_at, safe_error_code, retryable)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        id,
        chatId,
        options.turnId ?? null,
        role,
        text,
        status,
        createdAt,
        createdAt,
        options.safeErrorCode ?? null,
        options.retryable ? 1 : 0,
      );
    if (options.attachments?.length) {
      this.attachFilesToMessage(chatId, id, options.attachments);
    }
    const row = this.db
      .query<MessageRow, [string]>(
        `
      SELECT rowid, id, chat_id, turn_id, role, text, status, created_at, updated_at, safe_error_code, retryable
      FROM messages
      WHERE id = ?
    `,
      )
      .get(id);
    if (!row) throw new Error(`Failed to insert message: ${id}`);
    return messageFromRow(row, this.listMessageAttachments(id));
  }

  private insertAssistantReplies(
    chatId: string,
    turnId: string,
    texts: string[],
    files: MessageFileRow[] = [],
  ): MessageRecord[] {
    const replyTexts = texts.map((item) => item.trim()).filter(Boolean);
    const normalizedReplies =
      replyTexts.length > 0
        ? replyTexts
        : files.length > 0
          ? ["Butler attached a file."]
          : ["Butler did not return a visible reply."];
    return normalizedReplies.map((replyText, index) => {
      const reply = this.insertMessage(
        chatId,
        "assistant",
        replyText,
        "delivered",
        {
          turnId,
          attachments: index === normalizedReplies.length - 1 ? files : [],
        },
      );
      this.appendEvent("message.created", { message: reply });
      return reply;
    });
  }

  private insertOrReplaceAssistantReplies(
    chatId: string,
    turnId: string,
    texts: string[],
    files: MessageFileRow[] = [],
  ): MessageRecord[] {
    const replyTexts = texts.map((item) => item.trim()).filter(Boolean);
    const normalizedReplies =
      replyTexts.length > 0
        ? replyTexts
        : files.length > 0
          ? ["Butler attached a file."]
          : ["Butler did not return a visible reply."];
    const existing = this.getLatestAssistantMessageForTurn(turnId);
    if (!existing)
      return this.insertAssistantReplies(
        chatId,
        turnId,
        normalizedReplies,
        files,
      );

    const [firstReply, ...remainingReplies] = normalizedReplies;
    const attachFilesToUpdated = remainingReplies.length === 0 ? files : [];
    let updated = this.updateMessage(existing.id, {
      text: firstReply ?? "Butler did not return a visible reply.",
      status: "delivered",
      safeErrorCode: null,
      retryable: false,
    });
    if (attachFilesToUpdated.length > 0) {
      this.attachFilesToMessage(chatId, updated.id, attachFilesToUpdated);
      updated = this.messageRecordById(updated.id);
    }
    this.appendEvent("message.updated", { message: updated });
    if (remainingReplies.length === 0) return [updated];
    return [
      updated,
      ...this.insertAssistantReplies(chatId, turnId, remainingReplies, files),
    ];
  }

  private finalizeResponderLimitedDelivery(
    chatId: string,
    turnId: string,
    limitedDelivery: AppLimitedDelivery,
    options: { allowContinuation?: boolean; visibleNoReplyText?: string } = {},
  ): { reply?: MessageRecord; replies: MessageRecord[]; turn: TurnRecord } {
    if (
      options.allowContinuation !== false &&
      isContinuationDeliveryIssue(limitedDelivery.delivery.issue_kind)
    ) {
      return this.markResponderContinuation(chatId, turnId, limitedDelivery);
    }
    const text = limitedDelivery.text ?? options.visibleNoReplyText ?? null;
    const noVisibleReply = text === null;
    const deliveryState = publicDeliveryStateForProjection(
      limitedDelivery.delivery.delivery_state,
    );
    const limitations = limitedDelivery.delivery.limitations;
    const limitationCodes = limitedDelivery.delivery.limitation_codes;
    if (!this.hasTurnEventKind(turnId, "message.final.started")) {
      this.appendTurnEvent(chatId, turnId, {
        kind: "message.final.started",
        payload: { safeLabel: "Preparing final answer" },
      });
    }
    if (text === null) this.deleteAssistantMessagesForTurn(turnId);
    const replies = text === null
      ? []
      : this.insertOrReplaceAssistantReplies(chatId, turnId, [text]);
    if (noVisibleReply || !this.hasTurnEventKind(turnId, "message.final.completed")) {
      this.appendTurnEvent(chatId, turnId, {
        kind: "message.final.completed",
        payload: {
          safeLabel: "Final answer ready with limitations",
          textChars: text?.length ?? 0,
          noVisibleReply,
          deliveryState,
          delivery_state: deliveryState,
          limitations,
          limitationCodes,
          limitation_codes: limitationCodes,
        },
      });
    }
    const deliveredTurn = this.updateTurnState(turnId, "delivered", {
      safeStatusLabel: "Delivered with limitations",
      retryable: false,
      cancellable: false,
      safeErrorCode: null,
    });
    this.appendTerminalTurnStateChanged(deliveredTurn);
    if (noVisibleReply || !this.hasTurnEventKind(turnId, "turn.completed")) {
      this.appendTurnEvent(chatId, turnId, {
        kind: "turn.completed",
        payload: {
          safeLabel: "Completed with limitations",
          deliveryState,
          delivery_state: deliveryState,
          limitations,
          limitationCodes,
          limitation_codes: limitationCodes,
        },
      });
    }
    const projectedReplies = replies.map((reply) => ({
      ...reply,
      delivery_state: deliveryState,
      limitations,
      limitation_codes: limitationCodes,
    }));
    return {
      reply: projectedReplies.at(-1),
      replies: projectedReplies,
      turn: deliveredTurn,
    };
  }

  private markResponderContinuation(
    chatId: string,
    turnId: string,
    limitedDelivery: AppLimitedDelivery,
  ): { reply?: MessageRecord; replies: MessageRecord[]; turn: TurnRecord } {
    this.deleteAssistantMessagesForTurn(turnId);
    const currentTurn = this.getTurnRow(turnId);
    const deliveryState = limitedDelivery.delivery.delivery_state;
    const progressedDuringCurrentQueue =
      currentTurn && isInternalContinuationTurnState(currentTurn.state)
        ? this.hasPublicContinuationProgressSinceLatestQueue(turnId)
        : false;
    const shouldRequeue =
      shouldAutomaticallyRequeueContinuation(currentTurn, deliveryState) ||
      progressedDuringCurrentQueue;
    if (!shouldRequeue && currentTurn && isInternalContinuationTurnState(currentTurn.state)) {
      return { replies: [], turn: turnFromRow(currentTurn) };
    }
    const attempt = shouldRequeue && currentTurn
      ? currentTurn.attempt + 1
      : currentTurn?.attempt;
    const recoveryTurn = this.updateTurnState(
      turnId,
      shouldRequeue ? "retrying" : "waiting_for_tool",
      {
        safeStatusLabel: "",
        retryable: false,
        cancellable: true,
        safeErrorCode: null,
        attempt,
      },
    );
    this.appendEvent("turn.state_changed", { turn: recoveryTurn });
    if (shouldRequeue) this.requeueRecoverableAppTurn(chatId, recoveryTurn);
    return {
      replies: [],
      turn: recoveryTurn,
    };
  }

  private markResponderNonPublicContinuation(
    chatId: string,
    turnId: string,
  ): { reply?: MessageRecord; replies: MessageRecord[]; turn: TurnRecord } {
    return this.markResponderContinuation(chatId, turnId, {
      text: null,
      reason: "Continuation remains active.",
      delivery: {
        delivery_state: "running",
        issue_kind: "none",
        visibility: "continuation_progress",
        terminal: false,
        failure_notice: false,
        limitation_codes: [],
        limitations: [],
      },
    });
  }

  private hasPublicContinuationProgressSinceLatestQueue(turnId: string): boolean {
    const latestQueue = this.db
      .query<{ id: number }, [string]>(
        `
      SELECT id
      FROM events
      WHERE type = 'turn.queued'
        AND json_extract(payload_json, '$.turn_id') = ?
      ORDER BY id DESC
      LIMIT 1
    `,
      )
      .get(turnId);
    if (!latestQueue) return false;
    const internalContinuationEventIds =
      this.internalContinuationProgressEventIds(turnId);
    const rows = this.db
      .query<EventRow, [number, string]>(
        `
      SELECT id, type, payload_json, created_at
      FROM events
      WHERE id > ?
        AND json_extract(payload_json, '$.turn_id') = ?
        AND type IN ('progress.summary', 'agent.turn_event.progress')
      ORDER BY id ASC
      LIMIT 1000
    `,
      )
      .all(latestQueue.id, turnId);
    const progressRows: ProgressSummaryRow[] = [];
    for (const event of rows) {
      const payload = safeParseRecord(event.payload_json);
      if (payload.turn_id !== turnId) continue;
      const eventId = safeOptionalShortToken(payload.event_id);
      if (
        event.type === "agent.turn_event.progress" &&
        eventId &&
        internalContinuationEventIds.has(eventId)
      ) {
        continue;
      }
      const row = payload.row;
      if (!isRecord(row)) continue;
      progressRows.push(normalizeProgressSummaryRow(row));
    }
    const turn = this.getTurnRow(turnId);
    return publicProgressRowsForTurn(progressRows, turn?.state).length > 0;
  }

  private requeueRecoverableAppTurn(chatId: string, turn: TurnRecord): void {
    const row = this.getTurnRow(turn.id);
    if (!row?.user_message_id) return;
    const messageRow = this.getMessageRow(row.user_message_id);
    if (!messageRow) return;
    this.enqueueAppTransportTurn({
      chatId,
      turnId: turn.id,
      message: messageFromRow(messageRow, this.listMessageAttachments(messageRow.id)),
      text: messageRow.text,
      controls: this.getSessionControls(chatId),
    });
  }

  private deleteAssistantMessagesForTurn(turnId: string): void {
    const rows = this.db
      .query<MessageRow, [string]>(
        `
      SELECT rowid, id, chat_id, turn_id, role, text, status, created_at, updated_at, safe_error_code, retryable
      FROM messages
      WHERE turn_id = ? AND role = 'assistant'
      ORDER BY rowid DESC
    `,
      )
      .all(turnId);
    for (const row of rows) {
      this.db
        .query(
          `
        UPDATE message_files
        SET message_id = NULL
        WHERE message_id = ?
      `,
        )
        .run(row.id);
      this.db
        .query(
          `
        DELETE FROM message_attachments
        WHERE message_id = ?
      `,
        )
        .run(row.id);
      this.db.query("DELETE FROM messages WHERE id = ?").run(row.id);
      this.appendEvent("message.deleted", {
        message_id: row.id,
        chat_id: row.chat_id,
        turn_id: row.turn_id,
        role: row.role,
      });
    }
  }

  private upsertAssistantTurnFailure(
    chatId: string,
    turnId: string,
    safeError: { code: string; message: string },
    options: { retryable?: boolean } = {},
  ): MessageRecord {
    const existing = this.getLatestAssistantMessageForTurn(turnId);
    if (!existing) {
      const failed = this.insertMessage(
        chatId,
        "assistant",
        safeError.message,
        "failed",
        {
          turnId,
          safeErrorCode: safeError.code,
          retryable: options.retryable ?? false,
        },
      );
      this.appendEvent("message.created", { message: failed });
      return failed;
    }
    const failed = this.updateMessage(existing.id, {
      text: safeError.message,
      status: "failed",
      safeErrorCode: safeError.code,
      retryable: options.retryable ?? false,
    });
    this.appendEvent("message.updated", { message: failed });
    return failed;
  }

  private finalizeCancelledTurn(chatId: string, turnId: string): TurnRecord {
    const current = this.getTurnRow(turnId);
    if (current?.state === "cancelled") {
      this.ensureCancelledTurnActivityMessage(chatId, turnId);
      return this.getTurn(turnId);
    }
    const cancelledTurn = this.updateTurnState(turnId, "cancelled", {
      safeStatusLabel: "Cancelled",
      retryable: false,
      cancellable: false,
      safeErrorCode: null,
    });
    this.appendTerminalTurnStateChanged(cancelledTurn);
    if (!this.hasTurnEventKind(turnId, "turn.cancelled")) {
      this.appendTurnEvent(chatId, turnId, {
        kind: "turn.cancelled",
        payload: { safeLabel: "Cancelled" },
      });
    }
    this.ensureCancelledTurnActivityMessage(chatId, turnId);
    this.touchChat(chatId);
    void this.drainQueuedSessionMessages(chatId).catch(() => undefined);
    return cancelledTurn;
  }

  private ensureCancelledTurnActivityMessage(
    chatId: string,
    turnId: string,
  ): MessageRecord | null {
    const existingAssistant = this.listMessages(chatId).find(
      (message) => message.role === "assistant" && message.turn_id === turnId,
    );
    if (existingAssistant && isCancelledTurnActivityCarrier(existingAssistant)) {
      return null;
    }
    if (existingAssistant) this.deleteAssistantMessagesForTurn(turnId);
    const message = this.insertMessage(
      chatId,
      "assistant",
      CANCELLED_TURN_ACTIVITY_TEXT,
      "cancelled",
      { turnId },
    );
    const projected = this.messageWithTerminalWorkBlocks(message, turnId);
    this.appendEvent("message.created", { message: projected });
    return projected;
  }

  private messageWithTerminalWorkBlocks(
    message: MessageRecord,
    turnId: string,
  ): MessageRecord {
    const turn = this.getTurnRow(turnId);
    if (!turn || !isTerminalProgressState(turn.state)) return message;
    const delivery = this.deliveryLimitationMetadataForTurn(turnId);
    const publicDelivery = delivery
      ? publicDeliveryMetadataForProjection(delivery)
      : null;
    const workBlocks = workBlocksFromTerminalProgressRows(
      progressRowsForTurnState(this.listProgressRowsForTurn(turnId), turn.state),
    );
    return {
      ...message,
      ...(publicDelivery ?? {}),
      ...(workBlocks.length > 0 ? { work_blocks: workBlocks } : {}),
    };
  }

  private updateMessage(
    messageId: string,
    input: {
      text?: string;
      status?: MessageStatus;
      safeErrorCode?: string | null;
      retryable?: boolean;
    },
  ): MessageRecord {
    const current = this.getMessageRow(messageId);
    if (!current)
      throw new AppStoreOperationError(
        404,
        "message_not_found",
        "Message not found.",
      );
    const now = new Date().toISOString();
    this.db
      .query(
        `
      UPDATE messages
      SET text = ?, status = ?, updated_at = ?, safe_error_code = ?, retryable = ?
      WHERE id = ?
    `,
      )
      .run(
        input.text ?? current.text,
        input.status ?? current.status,
        now,
        input.safeErrorCode === undefined
          ? current.safe_error_code
          : input.safeErrorCode,
        input.retryable === undefined
          ? current.retryable
          : input.retryable
            ? 1
            : 0,
        messageId,
      );
    const row = this.getMessageRow(messageId);
    if (!row) throw new Error(`Failed to update message: ${messageId}`);
    return messageFromRow(row, this.listMessageAttachments(messageId));
  }

  private async runResponder(
    chatId: string,
    turnId: string,
    messageId: string,
    text: string,
    responder?: AppMessageResponder,
    options: SendMessageOptions = {},
    onProgress?: (row: ProgressSummaryInput) => void,
    onTurnEvent?: (event: RuntimeTurnEventInput) => void,
  ): Promise<AppMessageResponderResult> {
    const chat = this.getChatRow(chatId);
    const project = chat?.project_id
      ? this.getProjectRow(chat.project_id)
      : null;
    const settings = this.getSettings();
    if (!responder) {
      throw new Error("App responder is not configured for direct execution.");
    }
    const controller = new AbortController();
    this.activeTurnControllers.set(turnId, controller);
    try {
      return await runResponderWithTimeout(
        responder,
        {
          chatId,
          turnId,
          messageId,
          text,
          attachments: this.listMessageAttachments(messageId),
          sessionKind: chat?.kind ?? "chat",
          projectId: chat?.project_id ?? undefined,
          projectWorkspacePath: project?.workspace_path,
          model: options.controls?.model,
          reasoningEffort: options.controls?.reasoning_effort,
          workerModelRules: settings.worker_model_rules,
          accessMode: options.controls?.access_mode,
          planMode: options.controls?.plan_mode,
          onSessionTitle: this.generatedSessionTitleHandler(chatId, text),
          onProgress,
          onTurnEvent,
        },
        options.responderTimeoutMs,
        controller.signal,
      );
    } finally {
      if (this.activeTurnControllers.get(turnId) === controller) {
        this.activeTurnControllers.delete(turnId);
      }
    }
  }

  private touchChat(chatId: string): void {
    const now = new Date().toISOString();
    this.db
      .query("UPDATE chats SET updated_at = ? WHERE id = ?")
      .run(now, chatId);
  }

  private generatedSessionTitleHandler(
    chatId: string,
    sourceText: string,
  ): ((title: string) => void) | undefined {
    if (!this.isGeneratedSessionTitleEligible(chatId, sourceText)) {
      return undefined;
    }
    return (title: string) => {
      const normalized = normalizeGeneratedSessionTitle(title);
      if (!normalized) return;
      if (!this.isGeneratedSessionTitleEligible(chatId, sourceText)) return;
      const current = this.getChatRow(chatId);
      if (!current || current.title === normalized) return;
      this.updateSession(chatId, { title: normalized });
    };
  }

  private isGeneratedSessionTitleEligible(
    chatId: string,
    sourceText: string,
  ): boolean {
    const chat = this.getChatRow(chatId);
    if (!chat) return false;
    const counts = this.db
      .query<{ user_count: number; assistant_count: number }, [string]>(
        `
      SELECT
        COALESCE(SUM(CASE WHEN role = 'user' THEN 1 ELSE 0 END), 0) AS user_count,
        COALESCE(SUM(CASE WHEN role = 'assistant' THEN 1 ELSE 0 END), 0) AS assistant_count
      FROM messages
      WHERE chat_id = ?
    `,
      )
      .get(chatId);
    if (!counts || counts.user_count > 1 || counts.assistant_count > 0) {
      return false;
    }
    const currentTitle = chat.title.trim();
    const provisionalTitle = provisionalSessionTitleFromPrompt(
      sourceText,
      chat.kind,
    );
    const defaultTitle =
      chat.kind === "project" ? "New project chat" : "New chat";
    return currentTitle === defaultTitle ||
      (chat.kind === "chat" && currentTitle === DEFAULT_CHAT_TITLE) ||
      currentTitle === provisionalTitle;
  }

  private getTurnRow(turnId: string): TurnRow | null {
    return (
      this.db
        .query<TurnRow, [string]>(
          `
      SELECT rowid, id, chat_id, user_message_id, state, safe_status_label, safe_error_code,
        retryable, cancellable, attempt, created_at, updated_at
      FROM turns
      WHERE id = ?
    `,
        )
        .get(turnId) ?? null
    );
  }

  private turnExists(turnId: string): boolean {
    return Boolean(this.getTurnRow(turnId));
  }

  private isTerminalTurn(turnId: string): boolean {
    const turn = this.getTurnRow(turnId);
    return Boolean(turn && isTerminalTurnState(turn.state));
  }

  private shouldPersistRuntimeTurnEvent(turnId: string, kind: string): boolean {
    if (
      (kind === TURN_ACKNOWLEDGED_EVENT_KIND ||
        kind === FIRST_VISIBLE_PROGRESS_EVENT_KIND) &&
      this.hasTurnEventKind(turnId, kind)
    ) {
      return false;
    }
    const turn = this.getTurnRow(turnId);
    if (!turn || !isTerminalTurnState(turn.state)) return true;
    if (turn.state === "cancelled") return kind === "turn.cancelled";
    if (turn.state === "failed") return kind === "turn.failed";
    if (turn.state === "runtime_fault") return kind === "runtime.fault";
    if (turn.state === "delivered") return kind === "turn.completed";
    return false;
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
    const row = this.db
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

  private hasEquivalentProgressSummaryRow(
    turnId: string,
    input: ProgressSummaryInput,
  ): boolean {
    const incoming = normalizeProgressSummaryRow(input);
    const rows = this.db
      .query<EventRow, [string]>(
        `
      SELECT id, type, payload_json, created_at
      FROM events
      WHERE type IN ('progress.summary', 'agent.turn_event.progress')
        AND json_extract(payload_json, '$.turn_id') = ?
      ORDER BY id DESC
    `,
      )
      .all(turnId);
    return rows.some((row) => {
      const payload = safeParseRecord(row.payload_json);
      if (payload.turn_id !== turnId) return false;
      const progress = isRecord(payload.row) ? payload.row : null;
      if (!progress) return false;
      return progressRowsEquivalent(
        normalizeProgressSummaryRow(progress),
        incoming,
      );
    });
  }

  private getChatRow(chatId: string): ChatRow | null {
    return (
      this.db
        .query<ChatRow, [string]>(
          `
      SELECT id, title, kind, project_id, created_at, updated_at
      FROM chats
      WHERE id = ?
    `,
        )
        .get(chatId) ?? null
    );
  }

  private getProjectRow(projectId: string): ProjectRow | null {
    return (
      this.db
        .query<ProjectRow, [string]>(
          `
      SELECT id, display_name, status, workspace_path, workspace_label, safe_path_label,
        pinned, archived, error_summary, created_at, updated_at
      FROM projects
      WHERE id = ? AND archived = 0
    `,
        )
        .get(projectId) ?? null
    );
  }

  private getProjectRowAnyStatus(projectId: string): ProjectRow | null {
    return (
      this.db
        .query<ProjectRow, [string]>(
          `
      SELECT id, display_name, status, workspace_path, workspace_label, safe_path_label,
        pinned, archived, error_summary, created_at, updated_at
      FROM projects
      WHERE id = ?
    `,
        )
        .get(projectId) ?? null
    );
  }

  private getProjectForSession(sessionId: string): ProjectRow | null {
    const chat = this.getChatRow(sessionId);
    return chat?.project_id ? this.getProjectRow(chat.project_id) : null;
  }

  private safeSessionLabel(sessionId: string): string {
    try {
      return this.getSession(sessionId).title;
    } catch {
      return "Unavailable session";
    }
  }

  private projectMessageCountSince(
    projectId: string,
    sinceIso: string,
  ): number {
    const row = this.db
      .query<{ count: number }, [string, string]>(
        `
      SELECT COUNT(*) AS count
      FROM messages m
      JOIN chats c ON c.id = m.chat_id
      WHERE c.project_id = ? AND m.created_at >= ?
    `,
      )
      .get(projectId, sinceIso);
    return Math.max(0, Number(row?.count ?? 0));
  }

  private chatIdForRuntimeSession(runtimeSessionId: string): string | null {
    const rows = this.db
      .query<{ id: string }, []>("SELECT id FROM chats")
      .all();
    return (
      rows.find((row) => sessionHintForRow(row.id) === runtimeSessionId)?.id ??
      null
    );
  }

  private compactionMarkerMessages(
    chatId: string,
    cursor: number,
  ): MessageRecord[] {
    const snapshots = readCompactionSnapshots({
      butlerData: this.butlerData,
      sessionId: sessionHintForRow(chatId),
    }).filter((snapshot) => snapshot.status === "ok");
    if (snapshots.length === 0) return [];
    const messageTimeline = this.db
      .query<{ rowid: number; created_at: string }, [string]>(
        `
      SELECT rowid, created_at
      FROM messages
      WHERE chat_id = ?
      ORDER BY rowid ASC
    `,
      )
      .all(chatId);
    return snapshots.flatMap((snapshot) => {
      const previous = [...messageTimeline]
        .reverse()
        .find((row) => row.created_at <= snapshot.created_at);
      const markerCursor = Number(previous?.rowid ?? 0) + 0.25;
      if (markerCursor <= cursor) return [];
      const completedMs = Date.parse(snapshot.created_at);
      const startedAt = new Date(
        Number.isFinite(completedMs)
          ? Math.max(0, completedMs - 1)
          : Date.now(),
      ).toISOString();
      return [
        {
          id: `system-compaction-started-${snapshot.snapshot_id}`,
          chat_id: chatId,
          role: "system_event",
          text: "Context automatically compacting",
          status: "delivered",
          retryable: false,
          cursor: markerCursor,
          created_at: startedAt,
          updated_at: startedAt,
        },
        {
          id: `system-compaction-completed-${snapshot.snapshot_id}`,
          chat_id: chatId,
          role: "system_event",
          text: "Context automatically compacted",
          status: "delivered",
          retryable: false,
          cursor: markerCursor + 0.01,
          created_at: snapshot.created_at,
          updated_at: snapshot.created_at,
        },
      ];
    });
  }

  private getAutomationRow(automationId: string): AutomationRow | null {
    return (
      this.db
        .query<AutomationRow, [string]>(
          `
      SELECT id, title, prompt_body, target_kind, target_session_id, interval_seconds, state,
        next_run_at, last_run_at, last_run_state, last_safe_error_code,
        run_count, consecutive_failure_count, created_at, updated_at
      FROM app_automations
      WHERE id = ?
    `,
        )
        .get(automationId) ?? null
    );
  }

  private readSetting<T>(key: string): T | null {
    const row = this.db
      .query<
        SettingRow,
        [string]
      >("SELECT key, value_json FROM app_settings WHERE key = ?")
      .get(key);
    if (!row) return null;
    try {
      return JSON.parse(row.value_json) as T;
    } catch {
      return null;
    }
  }

  private readStoredProjectWorkspaceRoot(): string | null {
    const stored = this.readSetting<string>(
      DEFAULT_PROJECT_WORKSPACE_SETTING_KEY,
    );
    if (typeof stored !== "string" || !stored.trim()) return null;
    return resolve(stored);
  }

  private writeSetting(key: string, value: unknown): void {
    this.db
      .query(
        `
      INSERT INTO app_settings (key, value_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
    `,
      )
      .run(key, JSON.stringify(value), new Date().toISOString());
  }

  private branchInfoForSession(
    sessionId: string,
  ): SessionSummaryView["branch_info"] {
    const project = this.getProjectForSession(sessionId);
    if (!project) {
      return {
        available: false,
        workspace_mode: "none",
        safe_status: "No project workspace",
      };
    }
    return {
      available: false,
      workspace_mode: "folder",
      safe_status: "Project workspace",
    };
  }

  private getMessageRow(messageId: string): MessageRow | null {
    return (
      this.db
        .query<MessageRow, [string]>(
          `
      SELECT rowid, id, chat_id, turn_id, role, text, status, created_at, updated_at, safe_error_code, retryable
      FROM messages
      WHERE id = ?
    `,
        )
        .get(messageId) ?? null
    );
  }

  private messageRecordById(messageId: string): MessageRecord {
    const row = this.getMessageRow(messageId);
    if (!row)
      throw new AppStoreOperationError(
        404,
        "message_not_found",
        "Message not found.",
      );
    return messageFromRow(row, this.listMessageAttachments(messageId));
  }

  private getLatestAssistantMessageForTurn(turnId: string): MessageRow | null {
    return (
      this.db
        .query<MessageRow, [string]>(
          `
      SELECT rowid, id, chat_id, turn_id, role, text, status, created_at, updated_at, safe_error_code, retryable
      FROM messages
      WHERE turn_id = ? AND role = 'assistant'
      ORDER BY rowid DESC
      LIMIT 1
    `,
        )
        .get(turnId) ?? null
    );
  }

  private ensureColumn(
    table: string,
    column: string,
    definition: string,
  ): void {
    const rows = this.db
      .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
      .all();
    if (rows.some((row) => row.name === column)) return;
    this.db
      .query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
      .run();
  }

  private nextSessionTurnEventSequence(sessionId: string): number {
    const next =
      (this.sessionTurnEventSequences.get(sessionId) ??
        this.lastPersistedTurnEventSequence("session", sessionId)) + 1;
    this.sessionTurnEventSequences.set(sessionId, next);
    return next;
  }

  private nextTurnEventSequence(turnId: string): number {
    const next =
      (this.turnEventSequences.get(turnId) ??
        this.lastPersistedTurnEventSequence("turn", turnId)) + 1;
    this.turnEventSequences.set(turnId, next);
    return next;
  }

  private cleanupTurnEventSequences(sessionId: string, turnId: string): void {
    this.turnEventSequences.delete(turnId);
    this.sessionTurnEventSequences.delete(sessionId);
  }

  private lastPersistedTurnEventSequence(
    scope: "session" | "turn",
    id: string,
  ): number {
    const field = scope === "session" ? "$.session_id" : "$.turn_id";
    const rows = this.db
      .query<EventRow, [string]>(
        `
      SELECT id, type, payload_json, created_at
      FROM events
      WHERE type = 'agent.turn_event'
        AND json_extract(payload_json, '${field}') = ?
      ORDER BY id DESC
      LIMIT 20
    `,
      )
      .all(id);
    for (const row of rows) {
      const payload = safeParseRecord(row.payload_json);
      if (scope === "session" && payload.session_id !== id) continue;
      if (scope === "turn" && payload.turn_id !== id) continue;
      const event = isRecord(payload.event) ? payload.event : {};
      const sequence =
        scope === "session" ? event.sessionSequence : event.turnSequence;
      if (
        typeof sequence === "number" &&
        Number.isInteger(sequence) &&
        sequence > 0
      )
        return sequence;
    }
    return 0;
  }

  private hasTurnEventKind(turnId: string, kind: string): boolean {
    const row = this.db
      .query<{ id: number }, [string, string]>(
        `
      SELECT id
      FROM events
      WHERE type = 'agent.turn_event'
        AND json_extract(payload_json, '$.turn_id') = ?
        AND json_extract(payload_json, '$.event.kind') = ?
      ORDER BY id DESC
      LIMIT 1
    `,
      )
      .get(turnId, kind);
    return Boolean(row);
  }

  private runtimeFaultRecordForTurn(turnId: string): Record<string, unknown> | null {
    const row = this.db
      .query<EventRow, [string]>(
        `
      SELECT id, type, payload_json, created_at
      FROM events
      WHERE type = 'agent.turn_event'
        AND json_extract(payload_json, '$.turn_id') = ?
        AND json_extract(payload_json, '$.event.kind') = 'runtime.fault'
      ORDER BY id DESC
      LIMIT 1
    `,
      )
      .get(turnId);
    if (!row) return null;
    const payload = safeParseRecord(row.payload_json);
    const event = isRecord(payload.event) ? payload.event : null;
    const fault = event && isRecord(event.payload) ? event.payload : null;
    if (!fault) return null;
    const faultId = safeOptionalShortText(fault.faultId);
    const kind = safeOptionalShortText(fault.kind);
    const publicSummary = safeOptionalShortText(fault.publicSummary);
    const retryable = fault.retryable === true;
    if (!faultId || !kind || !publicSummary) return null;
    return {
      faultId,
      kind,
      retryable,
      publicSummary,
      ...(safeOptionalShortText(fault.sessionId)
        ? { sessionId: safeOptionalShortText(fault.sessionId) }
        : {}),
      ...(safeOptionalShortText(fault.turnId)
        ? { turnId: safeOptionalShortText(fault.turnId) }
        : {}),
      ...(safeOptionalShortText(fault.operatorSummary)
        ? { operatorSummary: safeOptionalShortText(fault.operatorSummary) }
        : {}),
      ...(safeOptionalShortText(fault.safeErrorCode)
        ? { safeErrorCode: safeOptionalShortText(fault.safeErrorCode) }
        : {}),
      ...(safeOptionalShortText(fault.safeCause)
        ? { safeCause: safeOptionalShortText(fault.safeCause) }
        : {}),
      createdAt: safeOptionalShortText(fault.createdAt) ?? row.created_at,
    };
  }

  private appendEvent(
    type: string,
    payload: Record<string, unknown>,
  ): AppEventEnvelope {
    const createdAt = new Date().toISOString();
    const publicPayload = publicAppEventPayload(type, payload);
    this.db
      .query(
        `
      INSERT INTO events (type, payload_json, created_at)
      VALUES (?, ?, ?)
    `,
      )
      .run(type, JSON.stringify(publicPayload), createdAt);
    const inserted = this.db
      .query<{ id: number }, []>("SELECT last_insert_rowid() AS id")
      .get();
    const row = this.db
      .query<EventRow, [number]>(
        `
      SELECT id, type, payload_json, created_at
      FROM events
      WHERE id = ?
    `,
      )
      .get(inserted?.id ?? 0);
    if (!row) throw new Error("Failed to append event.");
    const event: AppEventEnvelope = {
      protocol_version: APP_PROTOCOL_VERSION,
      id: row.id,
      type: row.type,
      created_at: row.created_at,
      payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    };
    for (const listener of [...this.eventSubscribers]) {
      try {
        listener(event);
      } catch {
        // Subscribers own their lifecycle. A transient write failure must not
        // permanently remove replay/live parity for future events.
      }
    }
    return event;
  }

  private createScratchProjectFolder(): string {
    try {
      mkdirSync(this.projectWorkspaceRoot, { recursive: true });
    } catch {
      throw new AppStoreOperationError(
        400,
        "project_workspace_unavailable",
        "Project workspace is not available.",
      );
    }
    const root = realpathSync(this.projectWorkspaceRoot);
    for (let index = 1; index < 1000; index += 1) {
      const folderName =
        index === 1
          ? SCRATCH_PROJECT_BASE_NAME
          : `${SCRATCH_PROJECT_BASE_NAME} ${index}`;
      const candidate = resolve(root, folderName);
      try {
        mkdirSync(candidate);
        return realpathSync(candidate);
      } catch (error) {
        if (isNodeError(error) && error.code === "EEXIST") continue;
        throw new AppStoreOperationError(
          400,
          "project_folder_unavailable",
          "Project folder could not be created.",
        );
      }
    }
    throw new AppStoreOperationError(
      409,
      "project_folder_name_exhausted",
      "Project folder name is unavailable.",
    );
  }

  private validateProjectFolder(folderPath: string): string {
    const workspacePath = resolve(folderPath);
    try {
      const stat = statSync(workspacePath);
      if (!stat.isDirectory()) {
        throw new AppStoreOperationError(
          400,
          "project_folder_invalid",
          "Project folder must be a directory.",
        );
      }
      accessSync(workspacePath, fsConstants.R_OK);
      const realWorkspacePath = realpathSync(workspacePath);
      if (isSensitiveProjectFolder(realWorkspacePath)) {
        throw new AppStoreOperationError(
          400,
          "project_folder_unsafe",
          "Project folder is not safe to use.",
        );
      }
      return realWorkspacePath;
    } catch (error) {
      if (error instanceof AppStoreOperationError) throw error;
      throw new AppStoreOperationError(
        400,
        "project_folder_invalid",
        "Project folder is not available.",
      );
    }
  }

  private getProjectRowByWorkspacePath(
    workspacePath: string,
  ): ProjectRow | null {
    return (
      this.db
        .query<ProjectRow, [string]>(
          `
      SELECT id, display_name, status, workspace_path, workspace_label, safe_path_label,
        pinned, archived, error_summary, created_at, updated_at
      FROM projects
      WHERE workspace_path = ? AND archived = 0
    `,
        )
        .get(workspacePath) ?? null
    );
  }

  private nextProjectId(displayName: string): string {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const suffix = crypto.randomUUID().slice(0, 8);
      const id = `project-${safeLocalSessionId(displayName)}-${suffix}`;
      if (!this.getProjectRow(id)) return id;
    }
    return `project-${crypto.randomUUID()}`;
  }
}

async function runResponderWithTimeout(
  responder: AppMessageResponder,
  input: Omit<AppMessageResponderInput, "signal">,
  timeoutMs?: number,
  externalSignal?: AbortSignal,
): Promise<AppMessageResponderResult> {
  const normalizedTimeoutMs = Number(timeoutMs);
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let removeExternalAbort: (() => void) | undefined;
  const abortController = () => {
    if (!controller.signal.aborted) {
      controller.abort();
    }
  };
  const races: Array<Promise<AppMessageResponderResult> | Promise<never>> = [
    Promise.resolve(responder({ ...input, signal: controller.signal })),
  ];

  if (Number.isFinite(normalizedTimeoutMs) && normalizedTimeoutMs > 0) {
    races.push(
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          abortController();
          reject(new AppResponderTimeoutError(normalizedTimeoutMs));
        }, normalizedTimeoutMs);
      }),
    );
  }

  if (externalSignal) {
    races.push(
      new Promise<never>((_, reject) => {
        const abort = () => {
          abortController();
          reject(new AppResponderCancelledError());
        };
        if (externalSignal.aborted) {
          abort();
          return;
        }
        externalSignal.addEventListener("abort", abort, { once: true });
        removeExternalAbort = () =>
          externalSignal.removeEventListener("abort", abort);
      }),
    );
  }

  try {
    return await Promise.race(races);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    removeExternalAbort?.();
  }
}

function readJsonFile<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function safeObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function safeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function sessionControlsKey(sessionId: string): string {
  return `session-controls:${safeLocalSessionId(sessionId)}`;
}

function sessionControlsExplicitKey(sessionId: string): string {
  return `session-controls-explicit:${safeLocalSessionId(sessionId)}`;
}

function hasSessionControlInput(input: Partial<SessionControlState>): boolean {
  return (
    input.model !== undefined ||
    input.reasoning_effort !== undefined ||
    input.access_mode !== undefined ||
    input.plan_mode !== undefined
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}
