import type { ReactElement, ReactNode } from "react";

export type ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh";
export type AccessMode = "full_access" | "ask_first" | "read_only";
export type ChatKind = "chat" | "project";
export type StatusTone = "ok" | "muted" | "error";
export type SettingsSectionId =
  | "general"
  | "models"
  | "appearance"
  | "server"
  | "updates"
  | "mcp"
  | "skills"
  | "usage"
  | "personalization"
  | "privacy"
  | "system"
  | "archives"
  | "about";
export type MessageFileKind = "text" | "image" | "generic";
export type RuntimeDeliveryState =
  | "running"
  | "waiting_user"
  | "system_error"
  | "cancelled"
  | "delivered"
  | "delivered_with_limitations"
  | "failed_system";

export interface StatusPill {
  label: string;
  tone: StatusTone;
}

export interface WorkerModelRule {
  id: string;
  label: string;
  condition: string;
  model: string;
  reasoning_effort: ReasoningEffort;
  enabled: boolean;
}

export interface AppModelSummary {
  provider_id: string;
  provider_label: string;
  model_id: string;
  model_ref: string;
  display_name: string;
  status: "latest" | "recommended" | "available" | "deprecated";
  context_window_tokens: number;
  max_output_tokens: number;
  default_reasoning_effort: ReasoningEffort;
  reasoning_efforts: ReasoningEffort[];
  reasoning_budget_tokens?: Partial<Record<ReasoningEffort, number>>;
  token_estimator: string;
  source_url?: string;
  runtime_supported: boolean;
  api_base_url?: string;
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

export type ProviderAuthMethod = "api_key" | "codex_oauth";

export interface ProviderCredentialView {
  id: string;
  provider_id: string;
  auth_type: ProviderAuthMethod;
  label: string;
  masked_value: string;
  created_at: string;
  updated_at: string;
}

export interface WorkerModelPreset {
  provider_id: string;
  provider_label: string;
  runtime_supported: boolean;
  source_url: string;
  deep_work: WorkerModelRule;
  routine_work: WorkerModelRule;
}

export interface ModelCatalogView {
  generated_at?: string;
  default_model_ref: string;
  default_reasoning_effort: ReasoningEffort;
  providers: Array<{
    provider_id: string;
    provider_label: string;
    latest_model_ref: string;
    auth_methods?: ProviderAuthMethod[];
    default_api_base_url?: string;
    models: AppModelSummary[];
  }>;
  models: AppModelSummary[];
  registered_models?: AppModelSummary[];
  provider_credentials?: ProviderCredentialView[];
  worker_model_presets: WorkerModelPreset[];
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

export interface LocalModelRegistrationRequest extends LocalModelDiscoveryRequest {
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

export interface LocalModelUpdateRequest extends LocalModelRegistrationRequest {}

export interface LocalModelDeletionResult {
  removed_model_ref: string;
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
  api_base_url?: string;
}

export interface HostedModelRegistrationResult {
  model: AppModelSummary;
  catalog: ModelCatalogView;
}

export interface HostedModelDeletionResult {
  removed_model_ref: string;
  catalog: ModelCatalogView;
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

export type UpdateComponentId = "service" | "app";
export type UpdateRestartPolicy = "restart-service" | "restart-app";
export type UpdatePolicy = "explicit" | "app-user-action";
export type UpdateProduct = "butler-agent" | "butler-app";
export type UpdateCanonicalComponent = "agent" | "app";
export type UpdateProfile = "agent-standalone" | "electron";
export type UpdateUpdaterOwner = "butler-agent" | "butler-app";
export type UpdatePayloadFormat = "agent-archive" | "platform-app-package";
export type UpdateStagingPolicy = "butler-data-updates" | "platform-updater-cache";
export type UpdateActivationPolicy = "versioned-standalone-runtime" | "platform-app-update-then-versioned-app-runtime";
export type UpdateRollbackPolicy = "preserve-previous-standalone-runtime" | "preserve-previous-app-managed-runtime";

export interface UpdateIntegrityMetadata {
  digestAlgorithm: "sha256";
  digest: string | null;
  signature: string | null;
}

export interface ComponentUpdateStatus {
  component: UpdateComponentId;
  current_version: string;
  available_version: string;
  update_available: boolean;
  channel: string;
  platform: string | null;
  artifact_url: string | null;
  sha256: string | null;
  signature: string | null;
  bundled_components: UpdateComponentId[];
  bundled_agent_version: string | null;
  product: UpdateProduct;
  canonical_component: UpdateCanonicalComponent;
  profile: UpdateProfile;
  protocol_compatibility: Record<string, string>;
  integrity: UpdateIntegrityMetadata;
  update_policy: UpdatePolicy;
  restart_policy: UpdateRestartPolicy;
  updater_owner: UpdateUpdaterOwner;
  payload_format: UpdatePayloadFormat;
  staging_policy: UpdateStagingPolicy;
  activation_policy: UpdateActivationPolicy;
  rollback_policy: UpdateRollbackPolicy;
  checked_at: string;
  staged: boolean;
  stage_path: string;
  stage_status: "up_to_date" | "staged" | "activated" | "rolled_back" | "dry_run";
  activation_status: "not_required" | "activated" | "rolled_back";
  active_runtime_path: string | null;
  attempted_runtime_path: string | null;
  previous_runtime_path: string | null;
  rollback_reason: string | null;
  manifest_source: string;
}

export interface UpdateStatusView {
  generated_at: string;
  components: ComponentUpdateStatus[];
  storage_label: "updates";
  manifest_source: string;
  raw_text_included: false;
}

export interface UpdateApplyResult extends ComponentUpdateStatus {
  dry_run: boolean;
  dryRun: boolean;
  artifact_path: string | null;
  planned_actions: string[];
  stage_status: "up_to_date" | "staged" | "activated" | "rolled_back" | "dry_run";
  activation_status: "not_required" | "activated" | "rolled_back";
  active_runtime_path: string | null;
  attempted_runtime_path: string | null;
  previous_runtime_path: string | null;
  rollback_reason: string | null;
  raw_text_included: false;
}

export interface SkillImportResult {
  imported: SkillSummaryView[];
  skipped: string[];
}

export interface AppInfoView {
  name: string;
  version: string;
  repository_url: string;
  protocol_version: string;
  developer_mode_available: boolean;
  developer_mode_enabled: boolean;
}

export interface SettingsView {
  bridge_mode: "local" | "external";
  gateway_profile: "electron";
  server_url: string;
  default_project_workspace_label: string;
  language: "en" | "ko";
  timezone: string;
  model: string;
  reasoning_effort: ReasoningEffort;
  consolidation_model: string;
  consolidation_reasoning_effort: ReasoningEffort;
  effective_consolidation_model: string;
  consolidation_uses_butler_model: boolean;
  context_window_tokens: number;
  worker_model_rules: WorkerModelRule[];
  access_mode: AccessMode;
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

export interface PersonalizationView {
  persona: string;
  eol: string;
  updated_at: string;
  response_language?: "en" | "ko";
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

export type ProfilingMode = "off" | "basic" | "deep";

export interface PersonalizationProfilingView {
  mode: ProfilingMode;
  enabled: boolean;
  consent_version: string;
  consented_at: string | null;
  storage_label: string;
  raw_profile_browser_visible: false;
  extractor_model: string;
  extractor_reasoning_effort?: ReasoningEffort;
  effective_extractor_model: string;
  extractor_uses_butler_model: boolean;
}

export interface PersonalizationProfilingUpdateRequest {
  mode?: ProfilingMode;
  extractor_model?: string;
  extractor_reasoning_effort?: ReasoningEffort;
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
  mode: ProfilingMode;
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
  response_language?: "en" | "ko";
  profile?: PersonalizationProfileUpdateRequest;
  profiling?: PersonalizationProfilingUpdateRequest;
}

export interface SessionControlState {
  model: string;
  reasoning_effort: ReasoningEffort;
  access_mode: AccessMode;
  plan_mode: boolean;
}

export interface SessionControlsView {
  session_id: string;
  controls: SessionControlState;
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
  last_activity_at: string;
  active_turn_state?: string;
  pinned: boolean;
  archived: boolean;
}

export interface CreateSessionResult {
  session: SessionSummary;
}

export interface ProjectSummary {
  id: string;
  display_name: string;
  last_activity_at: string;
  pinned: boolean;
  archived: boolean;
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
  generated_at?: string;
}

export interface ActiveChatView {
  title: string;
  shortTitle: string;
  project: string;
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

export interface MessageRecord {
  id: string;
  chat_id?: string;
  turn_id?: string;
  role:
    | "user"
    | "assistant"
    | "system"
    | "system_event"
    | "tool_summary"
    | "automation";
  text: string;
  attachments?: MessageFileRef[];
  artifacts?: SessionArtifactSummary[];
  work_blocks?: WorkBlockView[];
  status?: string;
  delivery_state?: RuntimeDeliveryState;
  limitation_codes?: string[];
  limitations?: string[];
  safe_error_code?: string;
  retryable?: boolean;
  cursor?: number;
  created_at?: string;
  updated_at?: string;
}

export interface QueuedMessageRecord {
  id: string;
  chat_id: string;
  text: string;
  attachments?: MessageFileRef[];
  controls: {
    model: string;
    reasoning_effort: ReasoningEffort;
    access_mode: AccessMode;
    plan_mode: boolean;
  };
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

export interface ContextUsageCategory {
  id: string;
  label: string;
  used_tokens: number;
  budget_tokens: number;
  ratio: number;
  safe_description: string;
  source_kind?: string;
}

export interface ContextDetailsView {
  session_id?: string;
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
  status?: string;
  categories: ContextUsageCategory[];
  updated_at?: string;
}

export interface ProgressDetailRow {
  id: string;
  kind?: string;
  safe_label: string;
  safe_value?: string;
  state?: string;
}

export interface ProgressRow {
  id: string;
  kind?: string;
  state: string;
  safe_label: string;
  safe_tool_name?: string;
  safe_input_label?: string;
  tool_call_id?: string;
  bridge_phase?: string;
  work_block_id?: string;
  work_block_label?: string;
  work_decision_summary?: string;
  work_decision_rationale?: string;
  work_decision_next_step?: string;
  work_decision_source?: string;
  work_decision_evidence_refs?: string[];
  runtime_fault_id?: string;
  runtime_fault_kind?: string;
  runtime_fault_retryable?: boolean;
  runtime_fault_public_summary?: string;
  runtime_fault_safe_error_code?: string;
  runtime_fault_safe_cause?: string;
  safe_path_labels?: string[];
  safe_detail_rows?: ProgressDetailRow[];
  safe_order?: number;
  created_at?: string;
}

export interface TurnProgressSnapshot {
  turn_id?: string;
  summary?: string;
  updated_at?: string;
  state?: string;
  delivery_state?: RuntimeDeliveryState;
  limitation_codes?: string[];
  limitations?: string[];
  safe_progress_rows: ProgressRow[];
}

export type SessionViewStatus =
  | "idle"
  | "active"
  | "delivered"
  | "failed"
  | "cancelled";

export interface SessionViewTurn {
  id: string;
  state: string;
  safe_status_label?: string;
  cancellable: boolean;
  retryable: boolean;
  delivery_state?: RuntimeDeliveryState;
  limitation_codes?: string[];
  limitations?: string[];
  progress: TurnProgressSnapshot;
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
  protocol_version?: string;
  session_id: string;
  kind: ChatKind;
  project_id?: string;
  status: SessionViewStatus;
  active_turn: SessionViewTurn | null;
  latest_turn: SessionViewTurn | null;
  messages: MessageRecord[];
  message_window: SessionViewMessageWindow;
  workers: WorkerActivitySummary[];
  work_streams: WorkStreamSummary[];
  artifacts: SessionArtifactSummary[];
  context: ContextDetailsView | null;
  branch: SessionSummaryView["branch_info"] | null;
  skills_used?: string[];
  automations: AutomationTargetSummary[];
  errors: SafeSessionError[];
  cursors: SessionViewCursors;
  generated_at: string;
  updated_at: string;
}

export interface MessageListView {
  chat_id?: string;
  messages: MessageRecord[];
  turn_progress?: Record<string, TurnProgressSnapshot>;
  next_cursor?: number;
}

export interface WorkBlockView {
  id: string;
  label: string;
  state: string;
  rows: ProgressRow[];
  decision_summary?: string;
  decision_rationale?: string;
  decision_next_step?: string;
  decision_source?: string;
  decision_evidence_refs?: string[];
  created_at?: string;
}

export interface AgentTurnEvent {
  id: string;
  sessionId: string;
  turnId: string;
  sessionSequence: number;
  turnSequence: number;
  createdAt?: string;
  kind: string;
  visibility?: "public" | "internal";
  payload?: Record<string, unknown>;
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
    scope: "general" | "project" | "onboarding";
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

export interface SessionArtifactSummary {
  id: string;
  session_id?: string;
  project_id?: string;
  message_id?: string;
  turn_id?: string;
  file_id?: string;
  title: string;
  kind: string;
  safe_path_label?: string;
  url?: string;
  size_bytes?: number;
  created_at: string;
  open_action?: "route" | "unsupported" | string;
}

export interface AutomationTargetSummary {
  automation_id: string;
  title: string;
  interval_label: string;
}

export type WorkerActivityPhase =
  | "orienting"
  | "planning"
  | "inspecting"
  | "executing"
  | "verifying"
  | "committing"
  | "consolidating"
  | "reporting"
  | "complete"
  | "blocked"
  | "failed"
  | "cancelled"
  | "recoverable"
  | string;

export interface WorkerActivitySummary {
  worker_id: string;
  activity_kind?: "planned" | "worker";
  worker_label: string;
  worker_display_name?: string;
  worker_ordinal_label?: string;
  objective: string;
  phase: WorkerActivityPhase;
  semantic_phase?: WorkerActivityPhase;
  action_kind?: string;
  status_line: string;
  current_activity_title?: string;
  work_blocks?: WorkBlockView[];
  session_id?: string;
  project_id?: string;
  task_id?: string;
  orchestration_id?: string;
  terminal: boolean;
  updated_at?: string;
  supported_controls: string[];
}

export interface WorkStreamSummary {
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

export interface SessionSummaryView {
  session_id?: string;
  turn_state?: string;
  latest_progress?: TurnProgressSnapshot;
  branch_info?: {
    branch_name?: string;
    safe_status?: string;
  };
  context_details?: ContextDetailsView;
  artifacts?: SessionArtifactSummary[];
  automation_targets?: AutomationTargetSummary[];
  skills_used?: string[];
  worker_activity?: WorkerActivitySummary[];
  work_streams?: WorkStreamSummary[];
}

export interface TimelineEvent {
  id?: number;
  type: string;
  created_at?: string;
  payload?: {
    message?: MessageRecord;
    turn?: {
      id: string;
      chat_id: string;
      state: string;
      safe_status_label?: string;
      updated_at?: string;
    };
    message_id?: string;
    chat_id?: string;
    role?: MessageRecord["role"];
    session_id?: string;
    turn_id?: string;
    state?: string;
    safe_status_label?: string;
    row?: ProgressRow;
    event?: AgentTurnEvent;
    event_id?: string;
  };
}

export type AppView =
  | { kind: "session" }
  | { kind: "settings"; section: SettingsSectionId }
  | { kind: "automations" }
  | { kind: "automation-detail"; automationId: string }
  | { kind: "project-dashboard"; projectId: string };

export interface CommandPaletteResult {
  id: string;
  kind: "chat" | "project" | "project_session" | "automation" | "settings";
  title: string;
  subtitle?: string;
  route: string;
}

export interface AutomationSummary {
  id: string;
  title: string;
  target_label: string;
  state: string;
  interval_label: string;
}

export interface AutomationRunSummary {
  id: string;
  state: string;
  started_at: string;
}

export interface SessionOption {
  id: string;
  label: string;
}

export interface ComposerControls {
  model?: string;
  reasoningEffort?: ReasoningEffort;
  accessMode?: AccessMode;
  planMode?: boolean;
  attachments?: MessageFileRef[];
  queuePolicy?: "send_now" | "enqueue_if_busy";
}

export type Updater<T> = T | ((previous: T) => T);

export type IconElement = ReactElement<{ size?: number }>;
export type ChildrenProps = { children?: ReactNode };
