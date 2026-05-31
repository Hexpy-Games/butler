// v1 allows backward-compatible optional response fields; bump only for
// required-field or incompatible semantic changes.
export const APP_PROTOCOL_VERSION = "butler.app.v1";

export type ChatKind = "chat" | "project";
export type MessageRole =
  | "user"
  | "assistant"
  | "system"
  | "system_event"
  | "tool_summary"
  | "automation";
export type ProjectStatus = "active" | "archived";
export type MessageStatus =
  | "pending"
  | "sent"
  | "thinking"
  | "streaming"
  | "delivered"
  | "failed"
  | "retrying"
  | "cancelled";
export type MessageFileKind = "text" | "image" | "generic";
export type TurnState =
  | "queued"
  | "accepted"
  | "thinking"
  | "streaming"
  | "waiting_for_form"
  | "waiting_for_tool"
  | "cancelling"
  | "cancelled"
  | "delivered"
  | "failed"
  | "retrying";

export interface ApiEnvelope<T> {
  protocol_version: typeof APP_PROTOCOL_VERSION;
  data: T;
}

export interface ApiErrorEnvelope {
  protocol_version: typeof APP_PROTOCOL_VERSION;
  error: {
    code: string;
    message: string;
  };
}

export interface AppInfoView {
  name: string;
  version: string;
  repository_url: string;
  protocol_version: typeof APP_PROTOCOL_VERSION;
  developer_mode_available: boolean;
  developer_mode_enabled: boolean;
}

export interface ChatSummary {
  id: string;
  title: string;
  kind: ChatKind;
  project_id?: string;
  created_at: string;
  updated_at: string;
}

export interface SessionSummary {
  id: string;
  kind: ChatKind;
  title: string;
  project_id?: string;
  project?: {
    id: string;
    display_name: string;
  };
  session_hint: string;
  created_at: string;
  updated_at: string;
  last_activity_at: string;
  last_message_preview?: string;
  active_turn_state?: TurnState;
  safe_status_label?: string;
  unread_count: number;
  pinned: boolean;
  archived: boolean;
  automation_target_count: number;
}

export interface ProjectSummary {
  id: string;
  display_name: string;
  status: ProjectStatus;
  last_activity_at: string;
  active_session_count: number;
  pinned: boolean;
  archived: boolean;
  error_summary?: string;
  workspace_label: string;
  safe_path_label: string;
  sessions?: SessionSummary[];
}

export interface NavigationView {
  chats: SessionSummary[];
  projects: ProjectSummary[];
  automations_summary: {
    total_count: number;
    enabled_count: number;
  };
  settings_summary: {
    profile_label: string;
  };
  generated_at: string;
}

export interface ProjectListView {
  projects: ProjectSummary[];
}

export interface SessionListView {
  sessions: SessionSummary[];
}

export interface ArchiveListView {
  projects: ProjectSummary[];
  sessions: SessionSummary[];
  pagination: PaginationView;
}

export interface SystemEventMetric {
  label: string;
  value: string | number | boolean;
}

export interface SystemEventSummary {
  id: string;
  kind: "scheduler_job" | "consolidation_run" | "profile_consolidation";
  title: string;
  status: string;
  occurred_at?: string;
  started_at?: string;
  completed_at?: string;
  duration_ms?: number;
  model_ref?: string;
  uses_butler_model?: boolean;
  metrics: SystemEventMetric[];
  raw_text_included: false;
}

export interface SystemEventListView {
  events: SystemEventSummary[];
  pagination: PaginationView;
  generated_at: string;
  raw_text_included: false;
}

export interface UsageTokenBucketView {
  requestCount: number;
  promptTokens: number;
  cachedTokens: number;
  uncachedTokens: number;
  outputTokens: number;
  totalTokens: number;
  missingTotalTokenCount: number;
}

export interface UsageMonitorView {
  filters: {
    sessionId: string | null;
    sinceTs: number | null;
  };
  model: UsageTokenBucketView & {
    cacheHitRatio: number;
    byScope: Record<string, number>;
    byScopeUsage: Record<string, UsageTokenBucketView>;
    byModel: Record<string, UsageTokenBucketView>;
  };
  webSearch: {
    requestCount: number;
    lastProvider: string | null;
    lastError: string | null;
  };
  tools: {
    calls: number;
    results: number;
    successes: number;
    failures: number;
    byTool: Record<string, {
      calls: number;
      results: number;
      successes: number;
      failures: number;
    }>;
  };
  providerUsage: {
    activeProviderId: string | null;
    providers: Array<UsageTokenBucketView & {
      providerId: string;
      source: "local_telemetry" | "provider_adapter";
      remaining: {
        available: boolean;
        reason: string;
      };
      billing: {
        available: boolean;
        reason: string;
      };
    }>;
  };
  cost: {
    available: false;
    estimatedUsd: null;
    reason: string;
  };
  privacy: {
    rawTextStored: false;
    rawToolArgumentsIncluded: false;
    rawToolResultsIncluded: false;
  };
  generated_at: string;
  raw_text_included: false;
}

export interface NewChatBriefingSuggestion {
  id: string;
  title: string;
  description: string;
  text: string;
}

export interface NewChatBriefingView {
  moment: string;
  title: string;
  description?: string;
  suggestions: NewChatBriefingSuggestion[];
  source: {
    scope: "general" | "project";
    content_origin: "generated" | "heuristic_fallback";
    consolidation_run_id: string | null;
    generated_at: string;
    locale: "ko" | "en";
    project_id?: string;
    project_name?: string;
    persona_applied: boolean;
    profile_projection_applied: boolean;
  };
  raw_text_included: false;
}

export interface PaginationView {
  limit: number;
  offset: number;
  total: number;
  has_more: boolean;
}

export interface ProjectSessionListView {
  project_id?: string;
  sessions: SessionSummary[];
}

export type CreateProjectSource = "scratch" | "existing_folder";

export interface CreateProjectRequest {
  source: CreateProjectSource;
  display_name?: string;
  folder_selection_token?: string;
  idempotency_key?: string;
}

export interface CreateProjectResult {
  project: ProjectSummary;
}

export interface UpdateProjectRequest {
  display_name?: string;
  pinned?: boolean;
  archived?: boolean;
}

export interface ProjectActionResult {
  project: ProjectSummary;
}

export interface CreateSessionRequest {
  kind: ChatKind;
  title?: string;
  initial_message?: string;
  project_id?: string;
  session_hint?: string;
  idempotency_key?: string;
}

export interface CreateSessionResult {
  session: SessionSummary;
}

export interface UpdateSessionRequest {
  title?: string;
  archived?: boolean;
}

export interface SessionActionResult {
  session: SessionSummary;
}

export type WebSearchProviderSetting =
  | "duckduckgo-html"
  | "auto"
  | "brave"
  | "tavily"
  | "openai-web-search"
  | "codex-subscription-web-search"
  | "disabled";

export type WebSearchReaderBackendSetting =
  | "lightweight"
  | "auto"
  | "lightpanda"
  | "jina-hosted"
  | "disabled";

export type WebSearchDefaultDepth = "quick" | "balanced" | "deep";

export interface WebSearchSettingsView {
  provider: WebSearchProviderSetting;
  reader_backend: WebSearchReaderBackendSetting;
  api_key_configured: boolean;
  api_key_env_var: string | null;
  planning_enabled: boolean;
  planning_default_depth: WebSearchDefaultDepth;
}

export interface WebSearchSettingsUpdate {
  provider?: WebSearchProviderSetting;
  reader_backend?: WebSearchReaderBackendSetting;
  api_key?: string;
  planning_enabled?: boolean;
  planning_default_depth?: WebSearchDefaultDepth;
}

export type UpdateComponentId = "service" | "app";
export type UpdateRestartPolicy = "restart-service" | "restart-app";
export type UpdatePolicy = "explicit" | "app-user-action";

export interface ComponentUpdateStatus {
  component: UpdateComponentId;
  current_version: string;
  available_version: string;
  update_available: boolean;
  channel: string;
  artifact_url: string | null;
  sha256: string | null;
  signature: string | null;
  bundled_components: UpdateComponentId[];
  update_policy: UpdatePolicy;
  restart_policy: UpdateRestartPolicy;
  checked_at: string;
  staged: boolean;
  stage_path: string;
  manifest_source: string;
}

export interface UpdateStatusView {
  generated_at: string;
  components: ComponentUpdateStatus[];
  storage_label: "updates";
  manifest_source: string;
  raw_text_included: false;
}

export interface UpdateCheckRequest {
  component?: UpdateComponentId;
  components?: UpdateComponentId[];
  channel?: string;
}

export interface UpdateApplyRequest {
  component: UpdateComponentId;
  channel?: string;
  dry_run?: boolean;
}

export interface UpdateApplyResult extends ComponentUpdateStatus {
  dry_run: boolean;
  dryRun: boolean;
  artifact_path: string | null;
  planned_actions: string[];
  stage_status: "up_to_date" | "staged" | "dry_run";
  raw_text_included: false;
}

export interface SettingsView {
  bridge_mode: "local" | "external";
  server_url: string;
  default_project_workspace_label: string;
  language: "en" | "ko";
  timezone: string;
  model: string;
  reasoning_effort: "none" | "low" | "medium" | "high" | "xhigh";
  consolidation_model: string;
  consolidation_reasoning_effort: "none" | "low" | "medium" | "high" | "xhigh";
  effective_consolidation_model: string;
  consolidation_uses_butler_model: boolean;
  context_window_tokens: number;
  worker_model_rules: WorkerModelRule[];
  access_mode: "full_access" | "ask_first" | "read_only";
  plan_mode_default: boolean;
  follow_up_behavior: "queue" | "steer";
  multiline_send_behavior:
    | "modifier_enter_send_enter_newline"
    | "enter_send_shift_enter_newline";
  appearance_theme: "system" | "light" | "dark";
  main_screen_theme: "none" | "bloom" | "silk";
  main_screen_theme_preset:
    | "monochrome"
    | "aurora"
    | "bloom"
    | "lavender"
    | "morning"
    | "custom";
  main_screen_theme_custom_colors: [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  translucent_sidebar: boolean;
  diagnostics_enabled: boolean;
  desktop_notifications: DesktopNotificationSettingsView;
  desktop_tray_enabled: boolean;
  web_search: WebSearchSettingsView;
  profile_label: string;
}

export interface DesktopNotificationSettingsView {
  enabled: boolean;
  assistant_messages: boolean;
  task_completions: boolean;
}

export interface WorkerModelRule {
  id: string;
  label: string;
  condition: string;
  model: string;
  reasoning_effort: "none" | "low" | "medium" | "high" | "xhigh";
  enabled: boolean;
}

export type McpTransportKind = "stdio" | "http" | "sse";
export type McpSecretSource = "literal" | "env" | "file";

export interface McpSecretInput {
  key: string;
  source: McpSecretSource;
  value: string;
}

export interface McpSecretView {
  key: string;
  source: McpSecretSource;
  value?: string;
  redacted: boolean;
  has_value: boolean;
}

export interface McpServerView {
  id: string;
  display_name: string;
  enabled: boolean;
  transport: McpTransportKind;
  command?: string;
  args: string[];
  cwd?: string;
  url?: string;
  env: McpSecretView[];
  headers: McpSecretView[];
  created_at: string;
  updated_at: string;
}

export interface McpServerListView {
  storage_path: string;
  servers: McpServerView[];
}

export interface McpServerMutationResult {
  server: McpServerView;
}

export interface McpServerDeleteResult {
  id: string;
  removed: boolean;
}

export interface McpServerUpsertRequest {
  id?: string;
  display_name?: string;
  enabled?: boolean;
  transport?: McpTransportKind;
  command?: string;
  args?: string[];
  cwd?: string;
  url?: string;
  env?: McpSecretInput[];
  headers?: McpSecretInput[];
}

export interface McpServerCapabilitiesView {
  id: string;
  display_name: string;
  enabled: boolean;
  transport: McpTransportKind;
  tools: Array<{
    name: string;
    qualified_name: string;
    description?: string;
    input_schema?: Record<string, unknown>;
  }>;
  resources: Array<{
    uri: string;
    name: string;
    description?: string;
    mime_type?: string;
  }>;
  resource_templates: Array<{
    uri_template: string;
    name: string;
    description?: string;
    mime_type?: string;
  }>;
  ok: boolean;
  error: string | null;
}

export interface McpCapabilitiesView {
  servers: McpServerCapabilitiesView[];
}

export interface SkillSummaryView {
  name: string;
  description: string;
  source: "core" | "user" | "project";
  project_id?: string;
  file_path: string;
  user_invocable: boolean;
}

export interface SkillProjectView {
  id: string;
  display_name: string;
  skills: SkillSummaryView[];
}

export interface SkillSettingsView {
  storage_root: string;
  core: SkillSummaryView[];
  user: SkillSummaryView[];
  projects: SkillProjectView[];
}

export interface SkillImportResult {
  imported: SkillSummaryView[];
  skipped: string[];
}

export type ProviderAuthMethod = "api_key" | "codex_oauth";

export interface AppModelSummary {
  provider_id: string;
  provider_label: string;
  model_id: string;
  model_ref: string;
  display_name: string;
  status: "latest" | "recommended" | "available" | "deprecated";
  context_window_tokens: number;
  max_output_tokens: number;
  default_reasoning_effort: "none" | "low" | "medium" | "high" | "xhigh";
  reasoning_efforts: Array<"none" | "low" | "medium" | "high" | "xhigh">;
  reasoning_budget_tokens?: Partial<
    Record<"none" | "low" | "medium" | "high" | "xhigh", number>
  >;
  token_estimator: string;
  source_url: string;
  runtime_supported: boolean;
  api_type?: "openai_compatible";
  platform?: "llama_cpp" | "ollama" | "lm_studio" | "custom";
  server_url?: string;
  source?: "discovered" | "manual";
  local_reasoning_budget_ratio?: number;
  registered?: boolean;
  auth_type?: ProviderAuthMethod;
  credential_id?: string;
  credential_label?: string;
  credential_masked_value?: string;
}

export interface ProviderCredentialView {
  id: string;
  provider_id: string;
  auth_type: ProviderAuthMethod;
  label: string;
  masked_value: string;
  created_at: string;
  updated_at: string;
}

export interface ModelCatalogView {
  generated_at: string;
  default_model_ref: string;
  default_reasoning_effort: "none" | "low" | "medium" | "high" | "xhigh";
  providers: Array<{
    provider_id: string;
    provider_label: string;
    latest_model_ref: string;
    auth_methods: ProviderAuthMethod[];
    models: AppModelSummary[];
  }>;
  models: AppModelSummary[];
  registered_models: AppModelSummary[];
  provider_credentials: ProviderCredentialView[];
  worker_model_presets: Array<{
    provider_id: string;
    provider_label: string;
    runtime_supported: boolean;
    source_url: string;
    deep_work: WorkerModelRule;
    routine_work: WorkerModelRule;
  }>;
}

export interface LocalModelDiscoveryRequest {
  provider_id: "local";
  api_type: "openai_compatible";
  platform: "llama_cpp" | "ollama" | "lm_studio" | "custom";
  server_url: string;
}

export interface LocalModelDiscoveryResult {
  server_url: string;
  api_base_url: string;
  api_type: "openai_compatible";
  platform: "llama_cpp" | "ollama" | "lm_studio" | "custom";
  models: AppModelSummary[];
}

export interface LocalModelRegistrationRequest {
  provider_id: "local";
  api_type: "openai_compatible";
  platform: "llama_cpp" | "ollama" | "lm_studio" | "custom";
  server_url: string;
  model_id: string;
  display_name?: string;
  context_window_tokens: number;
  max_output_tokens?: number;
  reasoning_budget_ratio?: number;
  source?: "discovered" | "manual";
}

export interface LocalModelRegistrationResult {
  model: AppModelSummary;
  catalog: ModelCatalogView;
}

export interface ProviderCredentialUpsertRequest {
  provider_id: string;
  auth_type: "api_key";
  label?: string;
  api_key: string;
  credential_id?: string;
}

export interface ProviderCredentialMutationResult {
  credential: ProviderCredentialView;
  catalog: ModelCatalogView;
}

export interface HostedModelRegistrationRequest {
  provider_id: string;
  model_id: string;
  display_name?: string;
  auth_type: ProviderAuthMethod;
  credential_id?: string;
  api_key?: string;
  credential_label?: string;
}

export interface HostedModelRegistrationResult {
  model: AppModelSummary;
  catalog: ModelCatalogView;
}

export interface HostedModelDeletionResult {
  removed_model_ref: string;
  catalog: ModelCatalogView;
}

export interface LocalModelUpdateRequest extends LocalModelRegistrationRequest {}

export interface LocalModelDeletionResult {
  removed_model_ref: string;
  catalog: ModelCatalogView;
}

export interface UpdateSettingsRequest {
  bridge_mode?: SettingsView["bridge_mode"];
  server_url?: string;
  language?: SettingsView["language"];
  timezone?: SettingsView["timezone"];
  model?: string;
  reasoning_effort?: SettingsView["reasoning_effort"];
  consolidation_model?: string;
  consolidation_reasoning_effort?: SettingsView["consolidation_reasoning_effort"];
  context_window_tokens?: number;
  worker_model_rules?: WorkerModelRule[];
  access_mode?: SettingsView["access_mode"];
  plan_mode_default?: boolean;
  follow_up_behavior?: SettingsView["follow_up_behavior"];
  multiline_send_behavior?: SettingsView["multiline_send_behavior"];
  appearance_theme?: SettingsView["appearance_theme"];
  main_screen_theme?: SettingsView["main_screen_theme"];
  main_screen_theme_preset?: SettingsView["main_screen_theme_preset"];
  main_screen_theme_custom_colors?: SettingsView["main_screen_theme_custom_colors"];
  translucent_sidebar?: boolean;
  diagnostics_enabled?: boolean;
  desktop_notifications?: Partial<DesktopNotificationSettingsView>;
  desktop_tray_enabled?: boolean;
  web_search?: WebSearchSettingsUpdate;
  default_project_folder_selection_token?: string;
}

export interface CommandPaletteResult {
  id: string;
  kind: "chat" | "project" | "project_session" | "automation" | "settings";
  title: string;
  subtitle?: string;
  route: string;
}

export interface CommandPaletteView {
  results: CommandPaletteResult[];
}

export interface PersonalizationView {
  persona: string;
  eol: string;
  updated_at: string;
  persona_presets: PersonaPresetView[];
  profile: PersonalizationProfileView;
  profiling: PersonalizationProfilingView;
}

export interface PersonaPresetView {
  name: string;
  label: string;
  description: string;
  preview: string;
  locale: "en" | "ko";
  content: string;
}

export interface PersonalizationProfileView {
  butler_nickname: string;
  principal_name: string;
  preferred_address: string;
  updated_at: string | null;
  storage_label: string;
}

export interface PersonalizationProfileUpdateRequest {
  butler_nickname?: string;
  principal_name?: string;
  preferred_address?: string;
}

export interface PersonalizationProfilingView {
  mode: "off" | "basic" | "deep";
  enabled: boolean;
  consent_version: string;
  consented_at: string | null;
  storage_label: string;
  raw_profile_browser_visible: false;
  extractor_model: string;
  extractor_reasoning_effort: SettingsView["reasoning_effort"];
  effective_extractor_model: string;
  extractor_uses_butler_model: boolean;
}

export interface PersonalizationProfilingUpdateRequest {
  mode?: "off" | "basic" | "deep";
  extractor_model?: string;
  extractor_reasoning_effort?: SettingsView["reasoning_effort"];
  clear_profile?: boolean;
}

export interface PersonalizationProfileMigrationRequest {
  source?: string;
  text: string;
  model?: string;
}

export interface PersonalizationProfileMigrationPromptView {
  locale: "en" | "ko";
  prompt: string;
  raw_profile_included: false;
}

export interface PersonalizationProfileMigrationResultView {
  profiling_enabled: boolean;
  mode: "off" | "basic" | "deep";
  source: string;
  import_id: string | null;
  imported_candidate_count: number;
  promoted_count: number;
  skipped_count: number;
  stable_entry_count: number;
  projection_written: boolean;
  raw_text_included: false;
  model_called: boolean;
  fallback_used: false;
  personalization: PersonalizationView;
}

export interface UpdatePersonalizationRequest {
  persona?: string;
  eol?: string;
  profile?: PersonalizationProfileUpdateRequest;
  profiling?: PersonalizationProfilingUpdateRequest;
}

export interface SessionControlState {
  model: string;
  reasoning_effort: SettingsView["reasoning_effort"];
  access_mode: SettingsView["access_mode"];
  plan_mode: boolean;
}

export interface SessionControlsView {
  session_id: string;
  controls: SessionControlState;
}

export interface ProjectDashboardActivityDay {
  date: string;
  count: number;
}

export type ProjectDashboardDocumentType =
  | "spec"
  | "plan"
  | "roadmap"
  | "work"
  | "task";

export interface ProjectDashboardDocument {
  id: string;
  kind: "spec" | "plan";
  document_type?: ProjectDashboardDocumentType;
  title: string;
  category?: string;
  status?: string;
  safe_path_label: string;
  markdown: string;
  updated_at: string;
}

export interface ProjectDashboardView {
  project: ProjectSummary;
  stats: {
    active_sessions: number;
    archived_sessions: number;
    recent_messages_7d: number;
    recent_messages_30d: number;
    specs: number;
    plans: number;
  };
  activity: {
    days: ProjectDashboardActivityDay[];
  };
  documents: ProjectDashboardDocument[];
  generated_at: string;
}

export interface ContextUsageCategory {
  id: string;
  label: string;
  used_tokens: number;
  budget_tokens: number;
  ratio: number;
  safe_description: string;
  source_kind:
    | "static_context"
    | "live_configuration"
    | "runtime_state"
    | "working_context"
    | "retrieved_context"
    | "current_input"
    | "references"
    | "output_reserve"
    | "tool_reserve"
    | "compaction_reserve";
}

export interface ContextDetailsView {
  session_id: string;
  model_ref?: string;
  provider_id?: string;
  model_id?: string;
  token_count_source?: string;
  used_tokens: number;
  budget_tokens: number;
  max_output_tokens?: number;
  available_working_context_tokens?: number;
  used_working_context_tokens?: number;
  usable_user_message_tokens?: number;
  auto_compact_at_tokens?: number;
  hard_pressure_at_tokens?: number;
  ratio: number;
  status: "low" | "medium" | "high";
  categories: ContextUsageCategory[];
  updated_at: string;
}

export interface ProgressDetailRow {
  id: string;
  kind?: string;
  safe_label: string;
  safe_value?: string;
  state?: string;
}

export interface ProgressSummaryRow {
  id: string;
  kind:
    | "explored"
    | "searched"
    | "read"
    | "ran_command"
    | "edited"
    | "dispatch"
    | "used_tool"
    | "thinking"
    | "worked_duration"
    | "message"
    | "turn"
    | "automation"
    | "worker"
    | "system"
    | string;
  safe_label: string;
  state: string;
  created_at: string;
  safe_tool_name?: string;
  safe_input_label?: string;
  tool_call_id?: string;
  work_block_id?: string;
  work_block_label?: string;
  work_decision_summary?: string;
  work_decision_rationale?: string;
  work_decision_next_step?: string;
  work_decision_source?: string;
  work_decision_evidence_refs?: string[];
  safe_count?: number;
  safe_path_labels?: string[];
  safe_detail_rows?: ProgressDetailRow[];
  safe_order?: number;
}

export interface WorkerActivityWorkBlock {
  id: string;
  label: string;
  state: string;
  rows: ProgressSummaryRow[];
  decision_summary?: string;
  decision_rationale?: string;
  decision_next_step?: string;
  decision_source?: string;
  decision_evidence_refs?: string[];
  created_at?: string;
}

export interface MessageFileRef {
  file_id: string;
  kind: MessageFileKind;
  mime_type: string;
  safe_name: string;
  size_bytes: number;
  sha256: string;
  url: string;
  created_at: string;
}

export interface MessageFileUploadResult {
  file: MessageFileRef;
}

export interface MessageAttachmentInput {
  file_id: string;
}

export interface SessionArtifactSummary {
  id: string;
  session_id?: string;
  project_id?: string;
  message_id?: string;
  turn_id?: string;
  file_id?: string;
  kind:
    | "csv_file"
    | "table_file"
    | "chart_file"
    | "image"
    | "document"
    | "code"
    | "report"
    | "file"
    | "unknown";
  title: string;
  safe_path_label?: string;
  url?: string;
  size_bytes?: number;
  created_at: string;
  open_action?: "route" | "unsupported";
}

export interface WorkStreamSummaryView {
  id: string;
  title: string;
  owner_session_id?: string;
  project_id?: string;
  state: string;
  current_phase?: string;
  active_step_id?: string;
  todo_list_id?: string;
  terminal: boolean;
  updated_at: string;
}

export interface TurnProgressSnapshotView {
  summary?: string;
  updated_at?: string;
  turn_id?: string;
  state?: TurnState | "idle";
  safe_progress_rows: ProgressSummaryRow[];
}

export type SessionViewStatus =
  | "idle"
  | "active"
  | "delivered"
  | "failed"
  | "cancelled";

export interface SessionViewTurn {
  id: string;
  state: TurnState;
  safe_status_label: string;
  cancellable: boolean;
  retryable: boolean;
  progress: TurnProgressSnapshotView;
  created_at: string;
  updated_at: string;
}

export interface SessionViewMessageWindow {
  next_cursor: number;
  complete: boolean;
}

export interface SafeSessionError {
  code: string;
  message: string;
  created_at: string;
}

export interface SessionViewCursors {
  messages: number;
  events: number;
}

export interface SessionView {
  protocol_version: typeof APP_PROTOCOL_VERSION;
  session_id: string;
  kind: ChatKind;
  project_id?: string;
  status: SessionViewStatus;
  active_turn: SessionViewTurn | null;
  latest_turn: SessionViewTurn | null;
  messages: MessageRecord[];
  message_window: SessionViewMessageWindow;
  workers: WorkerActivitySummary[];
  work_streams: WorkStreamSummaryView[];
  artifacts: SessionArtifactSummary[];
  context: ContextDetailsView | null;
  branch: SessionSummaryView["branch_info"] | null;
  skills_used: string[];
  automations: AutomationTargetSummary[];
  errors: SafeSessionError[];
  cursors: SessionViewCursors;
  generated_at: string;
  updated_at: string;
}

export interface SessionSummaryView {
  session_id: string;
  latest_progress: TurnProgressSnapshotView;
  turn_state: TurnState | "idle";
  branch_info: {
    available: boolean;
    workspace_mode: "git" | "folder" | "none";
    branch_name?: string;
    safe_status: string;
    safe_error_code?: string;
  };
  artifacts: SessionArtifactSummary[];
  skills_used: string[];
  context_details: ContextDetailsView;
  safe_errors: Array<{ code: string; message: string; created_at: string }>;
  automation_targets: AutomationTargetSummary[];
  worker_activity: WorkerActivitySummary[];
  work_streams: WorkStreamSummaryView[];
  staleness: {
    state: "fresh" | "stale" | "unavailable" | "failed";
    updated_at: string;
    source: string;
  };
}

export interface TranscriptExportView {
  session_id: string;
  format: "markdown";
  filename: string;
  content: string;
  message_count: number;
  generated_at: string;
}

export type AutomationState =
  | "enabled"
  | "paused"
  | "running"
  | "failed"
  | "deleted";
export type AutomationRunState =
  | "never_run"
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "skipped_target_unavailable"
  | "cancelled";

export interface AutomationTargetSummary {
  automation_id: string;
  title: string;
  state: AutomationState;
  interval_label: string;
  next_run_at?: string;
  last_run_state: AutomationRunState;
  safe_error_code?: string;
}

export interface AutomationSummary {
  id: string;
  title: string;
  state: AutomationState;
  target_kind: ChatKind;
  target_session_id: string;
  target_label: string;
  interval_seconds: number;
  interval_label: string;
  next_run_at?: string;
  last_run_at?: string;
  last_run_state: AutomationRunState;
  last_safe_error_code?: string;
  run_count: number;
  consecutive_failure_count: number;
  created_at: string;
  updated_at: string;
}

export interface AutomationDetail extends AutomationSummary {
  prompt_body: string;
}

export interface AutomationListView {
  automations: AutomationSummary[];
}

export interface AutomationDetailView {
  automation: AutomationDetail;
}

export interface AutomationRunSummary {
  id: string;
  automation_id: string;
  target_session_id: string;
  state: AutomationRunState;
  trigger: "scheduled" | "run_now";
  started_at: string;
  completed_at?: string;
  safe_error_code?: string;
  queued_message_id?: string;
  turn_id?: string;
}

export interface AutomationRunListView {
  runs: AutomationRunSummary[];
}

export interface CreateAutomationRequest {
  title: string;
  prompt_body: string;
  target_session_id: string;
  interval_seconds: number;
}

export interface UpdateAutomationRequest {
  title?: string;
  prompt_body?: string;
  target_session_id?: string;
  interval_seconds?: number;
  state?: "enabled" | "paused";
}

export interface AutomationMutationResult {
  automation: AutomationDetail | AutomationSummary;
}

export interface AutomationRunResult {
  automation: AutomationSummary;
  run: AutomationRunSummary;
}

export type WorkerActivityPhase =
  | "orienting"
  | "planning"
  | "executing"
  | "verifying"
  | "consolidating"
  | "reporting"
  | "complete"
  | "blocked"
  | "failed"
  | "cancelled"
  | "recoverable";

export interface WorkerActivitySummary {
  worker_id: string;
  activity_kind: "planned" | "worker";
  worker_label: string;
  objective: string;
  phase: WorkerActivityPhase;
  status_line: string;
  current_activity_title?: string;
  work_blocks?: WorkerActivityWorkBlock[];
  session_id?: string;
  project_id?: string;
  task_id?: string;
  orchestration_id?: string;
  terminal: boolean;
  updated_at: string;
  supported_controls: Array<"cancel" | "resume">;
}

export interface WorkerActivityListView {
  workers: WorkerActivitySummary[];
}

export interface WorkerActivityControlRequest {
  action: "cancel" | "resume";
}

export interface WorkerActivityControlResult {
  worker: WorkerActivitySummary;
  notice?: MessageRecord;
}

export interface MessageRecord {
  id: string;
  chat_id: string;
  turn_id?: string;
  role: MessageRole;
  text: string;
  status: MessageStatus;
  created_at: string;
  updated_at: string;
  safe_error_code?: string;
  retryable: boolean;
  cursor: number;
  attachments?: MessageFileRef[];
  artifacts?: SessionArtifactSummary[];
  work_blocks?: WorkerActivityWorkBlock[];
}

export interface MessageSendRequest {
  chat_id?: string;
  text?: string;
  client_message_id?: string;
  attachments?: MessageAttachmentInput[];
  model?: string;
  reasoning_effort?: SettingsView["reasoning_effort"];
  access_mode?: SettingsView["access_mode"];
  plan_mode?: boolean;
  queue_policy?: "send_now" | "enqueue_if_busy";
}

export interface MessageSendResult {
  accepted?: MessageRecord;
  queued?: QueuedMessageRecord;
  reply?: MessageRecord;
  replies: MessageRecord[];
  turn?: TurnRecord;
  next_cursor: number;
}

export interface QueuedMessageRecord {
  id: string;
  chat_id: string;
  text: string;
  attachments?: MessageFileRef[];
  controls: SessionControlState;
  state: "queued" | "dispatching" | "dispatched" | "deleted" | "failed";
  safe_error_code?: string;
  dispatched_message_id?: string;
  turn_id?: string;
  cursor: number;
  created_at: string;
  updated_at: string;
}

export interface SessionQueueView {
  session_id: string;
  queued_messages: QueuedMessageRecord[];
}

export interface QueueMessageRequest {
  chat_id?: string;
  text?: string;
  attachments?: MessageAttachmentInput[];
  model?: string;
  reasoning_effort?: SettingsView["reasoning_effort"];
  access_mode?: SettingsView["access_mode"];
  plan_mode?: boolean;
}

export interface UpdateQueuedMessageRequest {
  text?: string;
  attachments?: MessageAttachmentInput[];
  model?: string;
  reasoning_effort?: SettingsView["reasoning_effort"];
  access_mode?: SettingsView["access_mode"];
  plan_mode?: boolean;
}

export interface TurnRecord {
  id: string;
  chat_id: string;
  user_message_id?: string;
  state: TurnState;
  safe_status_label: string;
  safe_error_code?: string;
  retryable: boolean;
  cancellable: boolean;
  attempt: number;
  created_at: string;
  updated_at: string;
  cursor: number;
}

export interface AppEventEnvelope {
  protocol_version: typeof APP_PROTOCOL_VERSION;
  id: number;
  type:
    | "message.created"
    | "chat.created"
    | "server.status"
    | "turn.state_changed"
    | "context.compaction.started"
    | "context.compaction.completed"
    | string;
  created_at: string;
  payload: Record<string, unknown>;
}

export interface HealthView {
  ok: boolean;
  service: "butler-app-server";
  protocol_version: typeof APP_PROTOCOL_VERSION;
}

export interface MessageListView {
  chat_id: string;
  messages: MessageRecord[];
  turn_progress?: Record<string, TurnProgressSnapshotView>;
  next_cursor: number;
}

export interface EventReplayView {
  events: AppEventEnvelope[];
  next_cursor: number;
}

export interface TurnListView {
  chat_id: string;
  turns: TurnRecord[];
  next_cursor: number;
}

export interface TurnActionResult {
  turn: TurnRecord;
  reply?: MessageRecord;
  replies: MessageRecord[];
  next_cursor: number;
}

export function apiEnvelope<T>(data: T): ApiEnvelope<T> {
  return { protocol_version: APP_PROTOCOL_VERSION, data };
}

export function apiError(code: string, message: string): ApiErrorEnvelope {
  return { protocol_version: APP_PROTOCOL_VERSION, error: { code, message } };
}

export function isMessageSendRequest(
  value: unknown,
): value is MessageSendRequest {
  if (!value || typeof value !== "object") return false;
  const input = value as Partial<MessageSendRequest>;
  const hasText =
    typeof input.text === "string" && input.text.trim().length > 0;
  const hasAttachments =
    Array.isArray(input.attachments) &&
    input.attachments.length > 0 &&
    input.attachments.every(
      (attachment) =>
        Boolean(attachment) &&
        typeof attachment === "object" &&
        typeof attachment.file_id === "string" &&
        attachment.file_id.trim().length > 0,
    );
  return (
    (typeof input.text === "string" || hasAttachments) &&
    (hasText || hasAttachments)
  );
}

export function isQueueMessageRequest(
  value: unknown,
): value is QueueMessageRequest {
  if (!value || typeof value !== "object") return false;
  const input = value as Partial<QueueMessageRequest>;
  const hasText =
    typeof input.text === "string" && input.text.trim().length > 0;
  const hasAttachments =
    Array.isArray(input.attachments) &&
    input.attachments.length > 0 &&
    input.attachments.every(
      (attachment) =>
        Boolean(attachment) &&
        typeof attachment === "object" &&
        typeof attachment.file_id === "string" &&
        attachment.file_id.trim().length > 0,
    );
  return (
    (typeof input.text === "string" || hasAttachments) &&
    (hasText || hasAttachments)
  );
}

export function isCreateSessionRequest(
  value: unknown,
): value is CreateSessionRequest {
  if (!value || typeof value !== "object") return false;
  const input = value as Partial<CreateSessionRequest>;
  if (input.kind !== "chat" && input.kind !== "project") return false;
  if ("title" in input && typeof input.title !== "string") return false;
  if (
    "initial_message" in input &&
    typeof input.initial_message !== "string"
  )
    return false;
  if ("project_id" in input && typeof input.project_id !== "string")
    return false;
  if ("session_hint" in input && typeof input.session_hint !== "string")
    return false;
  if ("idempotency_key" in input && typeof input.idempotency_key !== "string")
    return false;
  return true;
}

const UPDATE_SESSION_KEYS = new Set(["title", "archived"]);

export function isUpdateSessionRequest(
  value: unknown,
): value is UpdateSessionRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  if (!Object.keys(input).every((key) => UPDATE_SESSION_KEYS.has(key)))
    return false;
  if ("title" in input && typeof input.title !== "string") return false;
  if ("archived" in input && typeof input.archived !== "boolean") return false;
  return true;
}

export function isCreateProjectRequest(
  value: unknown,
): value is CreateProjectRequest {
  if (!value || typeof value !== "object") return false;
  const input = value as Partial<CreateProjectRequest>;
  return input.source === "scratch" || input.source === "existing_folder";
}

const UPDATE_SETTINGS_KEYS = new Set([
  "bridge_mode",
  "server_url",
  "language",
  "timezone",
  "model",
  "reasoning_effort",
  "consolidation_model",
  "consolidation_reasoning_effort",
  "context_window_tokens",
  "worker_model_rules",
  "access_mode",
  "plan_mode_default",
  "follow_up_behavior",
  "multiline_send_behavior",
  "appearance_theme",
  "main_screen_theme",
  "main_screen_theme_preset",
  "main_screen_theme_custom_colors",
  "translucent_sidebar",
  "diagnostics_enabled",
  "desktop_notifications",
  "desktop_tray_enabled",
  "web_search",
  "default_project_folder_selection_token",
]);

const MCP_SERVER_UPSERT_KEYS = new Set([
  "id",
  "display_name",
  "enabled",
  "transport",
  "command",
  "args",
  "cwd",
  "url",
  "env",
  "headers",
]);

export function isMcpServerUpsertRequest(
  value: unknown,
): value is McpServerUpsertRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  if (!Object.keys(input).every((key) => MCP_SERVER_UPSERT_KEYS.has(key)))
    return false;
  if ("id" in input && typeof input.id !== "string") return false;
  if ("display_name" in input && typeof input.display_name !== "string")
    return false;
  if ("enabled" in input && typeof input.enabled !== "boolean") return false;
  if (
    "transport" in input &&
    input.transport !== "stdio" &&
    input.transport !== "http" &&
    input.transport !== "sse"
  ) {
    return false;
  }
  if ("command" in input && typeof input.command !== "string") return false;
  if ("cwd" in input && typeof input.cwd !== "string") return false;
  if ("url" in input && typeof input.url !== "string") return false;
  if (
    "args" in input &&
    (!Array.isArray(input.args) ||
      !input.args.every((item) => typeof item === "string"))
  ) {
    return false;
  }
  if ("env" in input && !isMcpSecretInputArray(input.env)) return false;
  if ("headers" in input && !isMcpSecretInputArray(input.headers)) return false;
  return true;
}

const WORKER_MODEL_RULE_KEYS = new Set([
  "id",
  "label",
  "condition",
  "model",
  "reasoning_effort",
  "enabled",
]);

export function isUpdateSettingsRequest(
  value: unknown,
): value is UpdateSettingsRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  if (!Object.keys(input).every((key) => UPDATE_SETTINGS_KEYS.has(key)))
    return false;
  if (
    "context_window_tokens" in input &&
    (typeof input.context_window_tokens !== "number" ||
      !Number.isFinite(input.context_window_tokens) ||
      input.context_window_tokens <= 0)
  ) {
    return false;
  }
  if ("language" in input && input.language !== "en" && input.language !== "ko")
    return false;
  if ("timezone" in input && !isIanaTimezone(input.timezone)) return false;
  if (
    "consolidation_model" in input &&
    typeof input.consolidation_model !== "string"
  )
    return false;
  if (
    "consolidation_reasoning_effort" in input &&
    !["none", "low", "medium", "high", "xhigh"].includes(
      String(input.consolidation_reasoning_effort),
    )
  )
    return false;
  if (
    "worker_model_rules" in input &&
    !isWorkerModelRuleList(input.worker_model_rules)
  )
    return false;
  if (
    "desktop_notifications" in input &&
    !isDesktopNotificationSettingsUpdate(input.desktop_notifications)
  )
    return false;
  if (
    "desktop_tray_enabled" in input &&
    typeof input.desktop_tray_enabled !== "boolean"
  )
    return false;
  if ("web_search" in input && !isWebSearchSettingsUpdate(input.web_search))
    return false;
  return true;
}

function isDesktopNotificationSettingsUpdate(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const input = value as Record<string, unknown>;
  return Object.keys(input).every((key) =>
    ["enabled", "assistant_messages", "task_completions"].includes(key) &&
    typeof input[key] === "boolean",
  );
}

export function isUpdateCheckRequest(
  value: unknown,
): value is UpdateCheckRequest {
  if (value === undefined || value === null) return true;
  if (typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  if (
    !Object.keys(input).every((key) =>
      ["component", "components", "channel"].includes(key),
    )
  ) {
    return false;
  }
  if (
    "component" in input &&
    input.component !== undefined &&
    !isUpdateComponentId(input.component)
  )
    return false;
  if (
    "components" in input &&
    input.components !== undefined &&
    (!Array.isArray(input.components) ||
      !input.components.every(isUpdateComponentId))
  ) {
    return false;
  }
  if (
    "channel" in input &&
    input.channel !== undefined &&
    typeof input.channel !== "string"
  )
    return false;
  return true;
}

export function isUpdateApplyRequest(
  value: unknown,
): value is UpdateApplyRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  if (
    !Object.keys(input).every((key) =>
      ["component", "channel", "dry_run"].includes(key),
    )
  ) {
    return false;
  }
  if (!isUpdateComponentId(input.component)) return false;
  if (
    "channel" in input &&
    input.channel !== undefined &&
    typeof input.channel !== "string"
  )
    return false;
  if (
    "dry_run" in input &&
    input.dry_run !== undefined &&
    typeof input.dry_run !== "boolean"
  )
    return false;
  return true;
}

function isUpdateComponentId(value: unknown): value is UpdateComponentId {
  return value === "service" || value === "app";
}

function isWebSearchSettingsUpdate(
  value: unknown,
): value is WebSearchSettingsUpdate {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  const allowed = new Set([
    "provider",
    "reader_backend",
    "api_key",
    "planning_enabled",
    "planning_default_depth",
  ]);
  if (!Object.keys(input).every((key) => allowed.has(key))) return false;
  if (
    "provider" in input &&
    ![
      "duckduckgo-html",
      "auto",
      "brave",
      "tavily",
      "openai-web-search",
      "codex-subscription-web-search",
      "disabled",
    ].includes(String(input.provider))
  )
    return false;
  if (
    "reader_backend" in input &&
    !["lightweight", "auto", "lightpanda", "jina-hosted", "disabled"].includes(
      String(input.reader_backend),
    )
  )
    return false;
  if ("api_key" in input && typeof input.api_key !== "string") return false;
  if (
    "planning_enabled" in input &&
    typeof input.planning_enabled !== "boolean"
  )
    return false;
  if (
    "planning_default_depth" in input &&
    !["quick", "balanced", "deep"].includes(
      String(input.planning_default_depth),
    )
  )
    return false;
  return true;
}

function isMcpSecretInputArray(value: unknown): value is McpSecretInput[] {
  return (
    Array.isArray(value) &&
    value.every((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item))
        return false;
      const input = item as Record<string, unknown>;
      return (
        typeof input.key === "string" &&
        typeof input.value === "string" &&
        (input.source === "literal" ||
          input.source === "env" ||
          input.source === "file")
      );
    })
  );
}

export function isUpdatePersonalizationRequest(
  value: unknown,
): value is UpdatePersonalizationRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  if (
    !Object.keys(input).every(
      (key) =>
        key === "persona" ||
        key === "eol" ||
        key === "profile" ||
        key === "profiling",
    )
  )
    return false;
  if ("persona" in input && typeof input.persona !== "string") return false;
  if ("eol" in input && typeof input.eol !== "string") return false;
  if ("profile" in input && !isPersonalizationProfileUpdate(input.profile)) {
    return false;
  }
  if (
    "profiling" in input &&
    !isPersonalizationProfilingUpdate(input.profiling)
  ) {
    return false;
  }
  return true;
}

export function isPersonalizationProfileMigrationRequest(
  value: unknown,
): value is PersonalizationProfileMigrationRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  const keys = new Set(["source", "text", "model"]);
  if (!Object.keys(input).every((key) => keys.has(key))) return false;
  if (typeof input.text !== "string") return false;
  if ("source" in input && typeof input.source !== "string") return false;
  if ("model" in input && typeof input.model !== "string") return false;
  return true;
}

function isPersonalizationProfileUpdate(
  value: unknown,
): value is PersonalizationProfileUpdateRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  const keys = new Set([
    "butler_nickname",
    "principal_name",
    "preferred_address",
  ]);
  if (!Object.keys(input).every((key) => keys.has(key))) return false;
  return Object.values(input).every((field) => typeof field === "string");
}

function isIanaTimezone(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim() || value.length > 96) {
    return false;
  }
  try {
    Intl.DateTimeFormat("en-US", { timeZone: value.trim() });
    return true;
  } catch {
    return false;
  }
}

function isPersonalizationProfilingUpdate(
  value: unknown,
): value is PersonalizationProfilingUpdateRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  const keys = new Set([
    "mode",
    "extractor_model",
    "extractor_reasoning_effort",
    "clear_profile",
  ]);
  if (!Object.keys(input).every((key) => keys.has(key))) return false;
  if (
    "mode" in input &&
    input.mode !== "off" &&
    input.mode !== "basic" &&
    input.mode !== "deep"
  ) {
    return false;
  }
  if ("clear_profile" in input && typeof input.clear_profile !== "boolean") {
    return false;
  }
  if ("extractor_model" in input && typeof input.extractor_model !== "string") {
    return false;
  }
  if (
    "extractor_reasoning_effort" in input &&
    !["none", "low", "medium", "high", "xhigh"].includes(
      String(input.extractor_reasoning_effort),
    )
  ) {
    return false;
  }
  return true;
}

export function isSessionControlUpdateRequest(
  value: unknown,
): value is Partial<SessionControlState> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  const keys = new Set([
    "model",
    "reasoning_effort",
    "access_mode",
    "plan_mode",
  ]);
  if (!Object.keys(input).every((key) => keys.has(key))) return false;
  if ("model" in input && typeof input.model !== "string") return false;
  if (
    "reasoning_effort" in input &&
    !["none", "low", "medium", "high", "xhigh"].includes(
      String(input.reasoning_effort),
    )
  )
    return false;
  if (
    "access_mode" in input &&
    !["full_access", "ask_first", "read_only"].includes(
      String(input.access_mode),
    )
  )
    return false;
  if ("plan_mode" in input && typeof input.plan_mode !== "boolean")
    return false;
  return true;
}

function isLocalModelPlatform(
  value: unknown,
): value is LocalModelDiscoveryRequest["platform"] {
  return (
    value === "llama_cpp" ||
    value === "ollama" ||
    value === "lm_studio" ||
    value === "custom"
  );
}

export function isLocalModelDiscoveryRequest(
  value: unknown,
): value is LocalModelDiscoveryRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Partial<LocalModelDiscoveryRequest>;
  return (
    input.provider_id === "local" &&
    input.api_type === "openai_compatible" &&
    isLocalModelPlatform(input.platform) &&
    typeof input.server_url === "string" &&
    input.server_url.trim().length > 0
  );
}

export function isLocalModelRegistrationRequest(
  value: unknown,
): value is LocalModelRegistrationRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Partial<LocalModelRegistrationRequest>;
  return (
    input.provider_id === "local" &&
    input.api_type === "openai_compatible" &&
    isLocalModelPlatform(input.platform) &&
    typeof input.server_url === "string" &&
    input.server_url.trim().length > 0 &&
    typeof input.model_id === "string" &&
    input.model_id.trim().length > 0 &&
    typeof input.context_window_tokens === "number" &&
    Number.isFinite(input.context_window_tokens) &&
    input.context_window_tokens > 0 &&
    (input.max_output_tokens === undefined ||
      (typeof input.max_output_tokens === "number" &&
        Number.isFinite(input.max_output_tokens) &&
        input.max_output_tokens > 0)) &&
    (input.reasoning_budget_ratio === undefined ||
      (typeof input.reasoning_budget_ratio === "number" &&
        Number.isFinite(input.reasoning_budget_ratio) &&
        input.reasoning_budget_ratio >= 0 &&
        input.reasoning_budget_ratio <= 1)) &&
    (input.display_name === undefined ||
      typeof input.display_name === "string") &&
    (input.source === undefined ||
      input.source === "discovered" ||
      input.source === "manual")
  );
}

export function isLocalModelUpdateRequest(
  value: unknown,
): value is LocalModelUpdateRequest {
  return isLocalModelRegistrationRequest(value);
}

function isHostedProviderId(
  value: unknown,
): value is HostedModelRegistrationRequest["provider_id"] {
  return (
    value === "openai" ||
    value === "anthropic" ||
    value === "google" ||
    value === "xai" ||
    value === "qwen" ||
    value === "kimi"
  );
}

function isProviderAuthMethod(value: unknown): value is ProviderAuthMethod {
  return value === "api_key" || value === "codex_oauth";
}

export function isProviderCredentialUpsertRequest(
  value: unknown,
): value is ProviderCredentialUpsertRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Partial<ProviderCredentialUpsertRequest>;
  return (
    isHostedProviderId(input.provider_id) &&
    input.auth_type === "api_key" &&
    typeof input.api_key === "string" &&
    input.api_key.trim().length > 0 &&
    (input.label === undefined || typeof input.label === "string") &&
    (input.credential_id === undefined ||
      typeof input.credential_id === "string")
  );
}

export function isHostedModelRegistrationRequest(
  value: unknown,
): value is HostedModelRegistrationRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Partial<HostedModelRegistrationRequest>;
  if (!isHostedProviderId(input.provider_id)) return false;
  if (
    typeof input.model_id !== "string" ||
    input.model_id.trim().length === 0
  ) {
    return false;
  }
  if (!isProviderAuthMethod(input.auth_type)) return false;
  if (input.auth_type === "codex_oauth" && input.provider_id !== "openai") {
    return false;
  }
  if (input.auth_type === "api_key") {
    const hasCredential =
      typeof input.credential_id === "string" &&
      input.credential_id.trim().length > 0;
    const hasApiKey =
      typeof input.api_key === "string" && input.api_key.trim().length > 0;
    if (!hasCredential && !hasApiKey) return false;
  }
  return (
    (input.display_name === undefined ||
      typeof input.display_name === "string") &&
    (input.credential_id === undefined ||
      typeof input.credential_id === "string") &&
    (input.api_key === undefined || typeof input.api_key === "string") &&
    (input.credential_label === undefined ||
      typeof input.credential_label === "string")
  );
}

function isWorkerModelRuleList(value: unknown): value is WorkerModelRule[] {
  if (!Array.isArray(value)) return false;
  return value.every((rule) => {
    if (!rule || typeof rule !== "object" || Array.isArray(rule)) return false;
    const input = rule as Record<string, unknown>;
    if (!Object.keys(input).every((key) => WORKER_MODEL_RULE_KEYS.has(key)))
      return false;
    if ("id" in input && typeof input.id !== "string") return false;
    if ("label" in input && typeof input.label !== "string") return false;
    if ("condition" in input && typeof input.condition !== "string")
      return false;
    if ("model" in input && typeof input.model !== "string") return false;
    if ("enabled" in input && typeof input.enabled !== "boolean") return false;
    if (
      "reasoning_effort" in input &&
      !["none", "low", "medium", "high", "xhigh"].includes(
        String(input.reasoning_effort),
      )
    ) {
      return false;
    }
    return true;
  });
}

export function isCreateAutomationRequest(
  value: unknown,
): value is CreateAutomationRequest {
  if (!value || typeof value !== "object") return false;
  const input = value as Partial<CreateAutomationRequest>;
  return (
    typeof input.title === "string" &&
    typeof input.prompt_body === "string" &&
    typeof input.target_session_id === "string" &&
    typeof input.interval_seconds === "number"
  );
}
