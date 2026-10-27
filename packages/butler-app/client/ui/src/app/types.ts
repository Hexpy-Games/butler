import type { AnswerBlockSet } from "../../../shared/app-contracts.ts";
import type { ReactElement, ReactNode } from "react";
// Relative (not `@/butler-ds`): the root typecheck reaches this file without the UI path aliases.
import type { WallpaperSetting, WallpaperSource } from "../libs/design-system/blocks/Wallpaper/types.ts";

export type ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max";
/** Wire values. `ask_first` asks before every action (모두 확인); `ask_except_reads` asks before changes and commands (먼저 확인). */
export type AccessMode = "read_only" | "ask_first" | "ask_except_reads" | "auto" | "full_access";
export type ChatKind = "chat" | "project";
export type StatusTone = "ok" | "muted" | "error";
export type SettingsSectionId =
  | "general"
  | "models"
  | "appearance"
  | "server"
  | "updates"
  | "mcp"
  | "hooks"
  | "skills"
  | "usage"
  | "logs"
  | "personalization"
  | "memory"
  | "browser"
  | "security"
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
  | "delivered_with_continuation"
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

export type WorkerProfileBuiltinJobName =
  | "coding"
  | "research"
  | "debug"
  | "review"
  | "writing";

export interface WorkerProfileBuiltinJob {
  kind: "builtin";
  job: WorkerProfileBuiltinJobName;
}

export interface WorkerProfileCustomJob {
  kind: "custom";
  text: string;
}

export type WorkerProfileJob = WorkerProfileBuiltinJob | WorkerProfileCustomJob;

export interface WorkerProfile {
  id: string;
  label: string;
  enabled: boolean;
  job: WorkerProfileJob;
  domain?: string;
  model: string;
  reasoning_effort: ReasoningEffort;
  prompt?: string;
}

export interface AppModelSummary {
  provider_id: string;
  provider_label: string;
  provider_family_id?: string;
  model_id: string;
  model_ref: string;
  display_name: string;
  status: "latest" | "recommended" | "available" | "deprecated";
  /** #278: the model's place in its provider's lineup. */
  tier?: "flagship" | "balanced" | "efficient";
  context_window_tokens?: number;
  max_output_tokens?: number;
  default_reasoning_effort: ReasoningEffort;
  reasoning_efforts: ReasoningEffort[];
  reasoning_budget_tokens?: Partial<Record<ReasoningEffort, number>>;
  token_estimator: string;
  source_url?: string;
  runtime_supported: boolean;
  availability?: "ready" | "sign_in_required" | "plan_off" | "not_in_plan";
  hosted_api_shape?:
    | "openai_chat_completions"
    | "openai_responses"
    | "anthropic_messages"
    | "gemini_generate_content";
  api_base_url?: string;
  api_type?: "openai_compatible";
  platform?: "llama_cpp" | "ollama" | "lm_studio" | "custom";
  server_url?: string;
  source?: "discovered" | "manual";
  local_reasoning_budget_ratio?: number;
  registered?: boolean;
  enabled?: boolean;
  auth_type?: ProviderAuthMethod;
  credential_id?: string;
  credential_label?: string;
  credential_masked_value?: string;
  /** Catalog image capability; absent means unknown. */
  image_input_support?: "supported" | "unsupported" | "unknown";
  /** Where image capability came from, e.g. "provider_catalog", "provider_discovery", or "user" (the user's declaration). */
  image_capability_source?: string;
  image_accepted_mime_types?: string[];
  image_max_inline_bytes?: number;
}

export type ChatGptSignInKind = "default" | "new_account" | "enable_plan";

export type ProviderAuthMethod = "api_key" | "chatgpt_oauth";

/** Where a saved API key is kept (#217). */
export type CredentialStorage =
  | "keychain"
  | "secret_service"
  | "credential_manager"
  | "fallback_file"
  | "legacy_plaintext";

export interface ProviderCredentialView {
  id: string;
  provider_id: string;
  auth_type: ProviderAuthMethod;
  label: string;
  masked_value: string;
  storage?: CredentialStorage;
  created_at: string;
  updated_at: string;
}

/** `GET /credentials`: a saved key and the registered models that use it. */
export interface SavedCredentialView extends ProviderCredentialView {
  model_refs: string[];
}

export interface CredentialListView {
  credentials: SavedCredentialView[];
  store: {
    backend: CredentialStorage;
    reason: "unsigned_build" | "signed_build" | "config" | "test_override";
    fallback_reason?: string;
    error?: string;
    override_ignored: boolean;
    legacy_plaintext: number;
  };
}

/** `DELETE /credentials/{name}`. */
export interface CredentialDeletionResult {
  credential: ProviderCredentialView;
  removed_model_refs: string[];
  secret_removed: boolean;
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
  generation: string;
  generated_at?: string;
  default_model_ref: string;
  default_reasoning_effort: ReasoningEffort;
  providers: Array<{
    provider_id: string;
    provider_label: string;
    latest_model_ref: string;
    chatgpt_plan_models?: string[] | null;
    auth_methods?: ProviderAuthMethod[];
    default_api_base_url?: string;
    models: AppModelSummary[];
    /** #230: the per-provider default first-run setup picks (model ref or id, effort). */
    presets?: { routine?: { model: string; effort: ReasoningEffort } };
  }>;
  models: AppModelSummary[];
  registered_models?: AppModelSummary[];
  provider_credentials?: ProviderCredentialView[];
  worker_model_presets: WorkerModelPreset[];
}

export interface LocalModelDiscoveryRequest {
  api_key?: string;
  model_ref?: string;
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
  /** The user's image input declaration; absent keeps the stored one. */
  image_input?: boolean;
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
  tool_filter_review_required?: boolean;
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
  | "chatgpt-plan-web-search"
  | "disabled";

export type WebSearchReaderBackendSetting =
  | "browser"
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
  /** "unavailable": no usable manifest at the last check; "unchecked": never checked. */
  check_state?: "ok" | "unavailable" | "unchecked";
  check_error?: string | null;
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

export interface UpdateProgressView {
  component: UpdateComponentId;
  stage: "idle" | "checking" | "downloading" | "verifying" | "ready" | "applying" | "restarting" | "failed" | "completed";
  revision: number;
  bytes_done: number | null;
  bytes_per_second?: number | null;
  bytes_total: number | null;
  cancellable: boolean;
  error_code: string | null;
}

export interface UpdateStatusView {
  progress?: UpdateProgressView | null;
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
  browser?: {
    browsing_agent: string;
    auto: { available?: boolean; model: string; effort: ReasoningEffort; rule: "family_sibling" | "provider_preset" | "conversation" };
  };
  /** Opaque id of the agent's data; it changes when Butler is reset. */
  data_generation?: string;
  update_previews?: boolean;
  bridge_mode: "local" | "external";
  gateway_profile: "electron";
  server_url: string;
  default_project_workspace_label: string;
  language: "en" | "ko";
  timezone: string;
  model: string;
  reasoning_effort: ReasoningEffort;
  recall_mode: "faster" | "accurate";
  recall_judge_model: string;
  proactive_level: "off" | "sometimes" | "often";
  quiet_hours_start: string;
  quiet_hours_end: string;
  chats_intro_seen: boolean;
  consolidation_time: string;
  consolidation_model: string;
  consolidation_reasoning_effort: ReasoningEffort;
  effective_consolidation_model: string;
  consolidation_uses_butler_model: boolean;
  context_window_tokens: number;
  worker_profiles: WorkerProfile[];
  max_simultaneous_workers: number;
  access_mode: AccessMode;
  /** A new schedule's access mode, resolved by the gateway (saved, else derived; D7). */
  schedule_access_mode?: AccessMode;
  command_sandbox_enabled?: boolean;
  command_sandbox_available?: boolean;
  plan_mode_default: boolean;
  follow_up_behavior: "queue" | "steer";
  multiline_send_behavior:
    | "modifier_enter_send_enter_newline"
    | "enter_send_shift_enter_newline";
  appearance_theme: "system" | "light" | "dark";
  text_size: "default" | "large" | "larger";
  /** false follows the OS; true forces the DS reduced-motion path. */
  reduce_motion: boolean;
  collapse_message_box: boolean;
  main_screen_theme: "none" | "bloom" | "silk" | "riso";
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
  /** The home screen wallpaper; derived from the legacy `main_screen_theme*` keys until one is saved. */
  wallpaper: WallpaperSetting;
  conversation_background: { source: WallpaperSource; overlay: number };
  composer_decoration: { theme: "none" | "shoreline" | "cherry"; character: boolean };
  translucent_sidebar: boolean;
  smart_grouping_enabled: boolean;
  show_thinking: boolean;
  diagnostics_enabled: boolean;
  /** Structured log preset; developer mode only (agents before #1218 omit it). */
  log_level?: "minimal" | "standard" | "detailed" | "full";
  log_category_levels?: Record<string, string>;
  /** The full-logging lease: when it ends and the preset it returns to. */
  log_full?: { expires_at: string; previous: string } | null;
  desktop_notifications: DesktopNotificationSettingsView;
  desktop_tray_enabled: boolean;
  web_search: WebSearchSettingsView;
  model_fallback: ModelFallbackSettingsView;
  profile_label: string;
  /** #230: onboarding state kept by the agent; absent on agents before #230. */
  onboarding?: OnboardingSettingsView;
  /** Local clients that send the admin credential only. */
  security?: SecuritySettingsView;
}

export interface OnboardingSettingsView {
  consent_version?: number | null;
  accepted_at?: string | null;
  completed_at?: string | null;
}

/** The `security` object of GET/PATCH /settings. */
export interface SecuritySettingsView {
  remote_access_enabled: boolean;
  allowed_hosts: string[];
  content_hosts?: string[];
}

/**
 * GET /security: local clients with the admin credential only (403
 * `loopback_required` or `admin_credential_required` otherwise).
 */
export interface SecurityView {
  remote_access_enabled: boolean;
  /** Every listen address, loopback first. */
  bind_addresses: string[];
  /** Empty while remote access is off. */
  lan_urls: string[];
  /** LAN bind failures; older gateways may omit the stable code. */
  bind_errors?: { address: string; code?: string; error: string }[];
  /** Extra host names the gateway answers (tunnels, reverse proxies). */
  allowed_hosts: string[];
  content_hosts?: string[];

}

export interface ModelFallbackSettingsView {
  enabled: boolean;
  models: string[];
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
  response_language_explicit?: boolean;
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
  revision: number;
  catalog_generation: string;
}

export type PlanDecisionAction = "accept" | "reject" | "instruct";

export interface PlanDecisionResultView {
  plan_document: ProjectDashboardDocument;
  controls: SessionControlsView;
  queued?: SessionQueueView;
}

export type ModelCatalogState =
  | "loading"
  | "ready"
  | "unavailable"
  | "error";

// The composer has no error state: a failed read falls back, never locks the picker.
export type ComposerModelState = Exclude<ModelCatalogState, "error">;

export type ControlsLoadState = "loading" | "ready" | "error";

export interface SessionSummary {
  epic_ids?: string[];
  session_hint?: string;
  work_progress?: { completed: number; total: number };
  id: string;
  kind: ChatKind;
  title: string;
  project_id?: string;
  created_at?: string;
  updated_at?: string;
  project?: {
    id: string;
    display_name: string;
  };
  last_activity_at: string;
  active_turn_state?: string;
  running_delegated_work?: boolean;
  attention_required?: boolean;
  pinned: boolean;
  archived: boolean;
  last_message_preview?: string;
  safe_status_label?: string;
  safe_status_label_key?: string;
  safe_status_label_parameters?: { attempt: number; maxAttempts: number };
  safe_status_content?: InterfaceContentReferences;
  /** A finished reply arrived after the owner last read this session. */
  unread?: boolean;
  automation_target_count?: number;
}

export interface CreateSessionResult {
  session: SessionSummary;
}

/**
 * A project folder's Git state; what the agent could not read is null. The
 * project list fills only `is_repo` and `branch`; the dashboard fills all.
 */
export interface ProjectGitState {
  is_repo: boolean;
  branch: string | null;
  dirty?: boolean | null;
  ahead?: number | null;
  behind?: number | null;
}

/** A project's wallpaper: follow the global `wallpaper` setting, or its own source. */
export type ProjectWallpaper = "inherit" | WallpaperSource;

export interface ProjectSummary {
  id: string;
  display_name: string;
  last_activity_at: string;
  pinned: boolean;
  archived: boolean;
  /** From the dashboard preferences; absent (older gateways, optimistic rows) means `inherit`. */
  wallpaper?: ProjectWallpaper;
  sessions?: SessionSummary[];
  /** Absent from agents that predate project Git state. */
  git?: ProjectGitState | null;
}

export type { SpaceCommand, SpaceNode, SpaceGroup, SpaceView, SpaceMutationResult } from "../../../shared/app-contracts.ts";

export interface NavigationView {
  archive_count?: number;
  space: import("../../../shared/app-contracts.ts").SpaceView;
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
  /** Where a new chat lands when it is not the project root (`Project › Group`). */
  location?: string;
}

export interface MessageFileRef {
  /** Workspace label the file was produced under; null on legacy rows. */
  source_label?: string | null;
  /** Handed to the user as a finished file (it is in the Library). */
  deliverable?: boolean;
  file_id: string;
  kind: MessageFileKind;
  mime_type: string;
  safe_name: string;
  size_bytes: number;
  sha256: string;
  url: string;
  /** Short-lived `url` with `?expires=..&signature=..` for token-less loads. */
  signed_url?: string;
  created_at: string;
  width?: number | null;
  height?: number | null;
}

export interface ChangedFileLine {
  type: "added" | "deleted";
  old_line?: number;
  new_line?: number;
  content: string;
}

export interface ChangedFileDetail {
  /** The stored copy of this file on the same message, when it has one. */
  file_id?: string | null;
  path: string;
  additions: number;
  deletions: number;
  lines: ChangedFileLine[];
}

export interface PlanDocumentRecord {
  id: string;
  title: string;
  status: string;
  markdown: string;
}

export interface MessageRecord {
  /** Terminal failure grouped with this turn's retained partial answer. */
  failure_notice?: MessageRecord;
  initiated?: import("./initiatedTypes").InitiatedOrigin;
  question_answer?: AnsweredUserQuestions;
  question_summary?: UserQuestion[];
  system_event_kind?: "context.compaction.started" | "context.compaction.completed";
  content_parts?: import("./messageContent").MessageContent;
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
  plan_document?: PlanDocumentRecord;
  answer_blocks?: Array<AnswerBlockSet>;
  attachments?: MessageFileRef[];
  artifacts?: SessionArtifactSummary[];
  changed_files?: ChangedFileDetail[];
  work_blocks?: WorkBlockView[];
  turn_activity_rows?: ProgressRow[];
  status?: string;
  delivery_state?: RuntimeDeliveryState;
  limitation_codes?: string[];
  limitations?: string[];
  safe_error_code?: string;
  retryable?: boolean;
  incomplete?: boolean;
  retry_mode?: "resume" | "fresh";
  retry_with_current_controls?: boolean;
  cursor?: number;
  created_at?: string;
  updated_at?: string;
}

export interface QueuedMessageRecord {
  content_parts?: import("./messageContent").MessageContent;
  id: string;
  chat_id: string;
  text: string;
  /** Transport id of the send; the delivered user message reuses it. */
  client_message_id?: string;
  plan_id?: string;
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
  /** Stopped turn: queued messages wait for the next user input. */
  paused?: boolean;
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
  failure_code?: string;
  auth_type?: ProviderAuthMethod | null;
  id: string;
  turn_id?: string;
  kind?: string;
  state: string;
  safe_label: string;
  turn_event_sequence?: number;
  safe_tool_name?: string;
  safe_input_label?: string;
  tool_call_id?: string;
  thinking_title?: string;
  thinking_body?: string;
  tool_result_id?: string;
  tool_result_byte_length?: number;
  bridge_phase?: string;
  interface_label_key?: string;
  interface_content?: InterfaceContentReferences;
  interface_label_parameters?: { attempt: number; maxAttempts: number };
  receipt_kind?: string;
  public_decision_role?: string;
  public_decision_summary?: string;
  public_decision_rationale?: string;
  public_decision_next_step?: string;
  public_decision_source?: string;
  public_decision_model_call_id?: string;
  public_decision_latency_ms?: number;
  public_decision_evidence_refs?: string[];
  work_contract_id?: string;
  work_stream_id?: string;
  semantic_block_id?: string;
  activity_stage?: string;
  work_block_id?: string;
  work_block_label?: string;
  work_block_phase?: "started" | "updated" | "completed";
  work_block_sequence?: number;
  work_decision_id?: string;
  work_decision_title?: string;
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

export interface OperationOutputView {
  turn_id: string;
  request_id: string;
  result_id: string;
  content: string;
  byte_start: number;
  byte_end: number;
  byte_length: number;
  complete: boolean;
}

export interface TurnProgressSnapshot {
  summary_reference?: InterfaceTextReference;
  turn_id?: string;
  started_at?: string;
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
  /** Optional: the gateway may omit progress for a turn (treat as no rows). */
  progress?: TurnProgressSnapshot;
  created_at: string;
  updated_at: string;
  execution_controls?: {
    model_ref: string;
    reasoning_effort: ReasoningEffort;
    source: "message_override" | "session_override" | "global_default";
    subsession_result?: {
      relation_id: string;
      result_id: string;
      safe_title: string;
    };
  };
  execution_model?: {
    requested_model_ref: string;
    adapter_effective_model_ref: string;
    provider_reported_model_ref?: string;
  };
}

export interface SessionViewMessageWindow {
  next_cursor: number;
  complete: boolean;
  previous_cursor?: number;
  previous_cursor_token?: string;
  requested_cursor?: number;
  requested_cursor_token?: string;
  requested_before_cursor?: number;
  requested_before_cursor_token?: string;
  next_cursor_token?: string;
  has_more?: boolean;
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

export interface SessionRelationView {
  relation_id: string;
  parent_session_id: string;
  parent_turn_id: string;
  child_session_id: string;
  anchor_message_id: string;
  ordinal: number;
  safe_title: string;
  created_at: string;
}

export interface StewardResultView {
  result_id: string;
  relation_id: string;
  task_id: string;
  child_session_id: string;
  child_turn_id: string;
  status: "success" | "blocked" | "failed" | "cancelled";
  code:
    | "delegation_context_incomplete"
    | "steward_execution_failed"
    | "steward_cancelled"
    | null;
  summary: string;
  acceptance_evidence: string[];
  changed_artifacts: string[];
  changed_files?: ChangedFileDetail[];
  created_at: string;
}

export interface StewardSessionSummaryView {
  relation: SessionRelationView;
  session_id: string;
  title: string;
  status: SessionViewStatus;
  active_turn: SessionViewTurn | null;
  latest_turn: SessionViewTurn | null;
  waiting_for_children?: boolean;
  activity_rows: ProgressRow[];
  approved_plan_revision?: number;
  approved_plan_total?: number;
  approved_plan_completed?: number;
  artifacts: SessionArtifactSummary[];
  changed_files: ChangedFileDetail[];
  result: StewardResultView | null;
  updated_at: string;
  terminal: boolean;
}

export interface SessionView {
  epic_ids?: string[];
  approved_plan_revision?: number;
  approved_plan_total?: number;
  approved_plan_completed?: number;
  authority_requests?: unknown[];
  pending_questions?: PendingUserQuestions[];
  question_answers?: AnsweredUserQuestions[];
  branch_seed?: import("../../../shared/app-contracts.ts").SessionBranchSeed;
  protocol_version?: string;
  session_id: string;
  kind: ChatKind;
  project_id?: string;
  status: SessionViewStatus;
  active_turn: SessionViewTurn | null;
  latest_turn: SessionViewTurn | null;
  waiting_for_children?: boolean;
  messages: MessageRecord[];
  activity_history?: Array<{ turn_id: string; created_at: string; rows: ProgressRow[] }>;
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
  parent_session_id?: string;
  relation?: SessionRelationView;
  steward_children?: StewardSessionSummaryView[];
  generated_at: string;
  updated_at: string;
}

/**
 * Serializable Electron preload result for the canonical `/session-view`
 * request. The preload must return this union rather than reject with a
 * custom Error because contextBridge preserves only standard Error fields.
 */
export interface SessionViewBridgeInput {
  sessionId?: string;
  cursorToken?: string;
  beforeCursorToken?: string;
  limit?: number;
}

export interface SessionViewBridgeError {
  existing?: import("../../../shared/canon-contracts.ts").CanonTag;
  current?: { revision: number };
  hook_reason?: string;
  schema: "butler.app.bridge-error.v1";
  code: string;
  status?: number;
  resync?: {
    required: true;
    resource: "session-view";
    reason: "cursor-expired";
  };
}

export type SessionViewBridgeResult =
  | { ok: true; data: SessionView }
  | { ok: false; error: SessionViewBridgeError };

export interface MessageListView {
  chat_id?: string;
  messages: MessageRecord[];
  turn_progress?: Record<string, TurnProgressSnapshot>;
  next_cursor?: number;
  next_cursor_token?: string;
}

export interface WorkBlockView {
  id: string;
  label: string;
  state: string;
  rows: ProgressRow[];
  decision_title?: string;
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
  | "artifact"
  | "reference"
  | "message"
  | "report"
  | "spec"
  | "plan"
  | "roadmap"
  | "work"
  | "task";

export interface ProjectDashboardDocument {
  artifact?: SessionArtifactSummary;
  unavailable?: boolean;
  revision?: string;
  project_id?: string;
  truncated?: boolean;
  nextCursor?: string | null;
  id: string;
  kind: "spec" | "plan" | "report";
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
  /** Present only when the provider reports reasoning tokens. */
  reasoningTokens?: number;
  totalTokens: number;
  missingTotalTokenCount: number;
}

export interface UsageSectionBucketView {
  requestCount: number;
  chars: number;
  estimatedTokens: number;
}

export interface UsageHistoryView {
  lifetimeTokens: number;
  busiestDay: { date: string; tokens: number } | null;
  longestTask: { durationMs: number; sessionId: string; title: string | null } | null;
  longestStreak: { days: number; start: string | null; end: string | null };
  currentStreak: { days: number; start: string | null };
  days: [string, number][];
  priorTotal: number;
  firstActiveDate: string | null;
  timeZone: string;
}

export interface UsageMonitorView {
  /** Session views append the slot's delegated tokens (prompt + output of every role other than "main"), then that work's requests, cached and output. */
  timeline: { slotMinutes: 15; slots: ([number, number, number, number, number] | [number, number, number, number, number, number, number, number, number])[] };
  topSessions: { sessionId: string; title: string | null; kind: "chat" | "schedule" | "butler"; totalTokens: number; requests: number; lastUsedMs: number | null }[];
  previousPeriod: { totalTokens: number } | null;
  filters: {
    sessionId: string | null;
    sinceTs: number | null;
    untilTs: number | null;
  };
  model: UsageTokenBucketView & {
    cacheHitRatio: number;
    byScope: Record<string, number>;
    byScopeUsage: Record<string, UsageTokenBucketView>;
    byModel: Record<string, UsageTokenBucketView>;
    bySection: Record<string, UsageSectionBucketView>;
    /** Session views only: the chat's calls by role ("main" = the chat itself; any other role is delegated work), included in the totals above. */
    byRole?: Record<string, UsageTokenBucketView>;
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
      monthTokens?: number;
      source: "local_telemetry" | "provider_adapter";
      remaining: ProviderQuotaResultView;
      butlerUsage?: ButlerUsageView | null;
      billing: {
        available: boolean;
        reason: string;
      };
    }>;
  };
  cost: {
    /** False until the gateway prices usage from its rate table. */
    available: boolean;
    estimatedUsd: number | null;
    reason: string;
    /** Rate table date; present when the cost is an estimate. */
    asOf?: string | null;
  };
  privacy: {
    rawTextStored: false;
    rawToolArgumentsIncluded: false;
    rawToolResultsIncluded: false;
  };
  generated_at: string;
  raw_text_included: false;
}

export type ProviderQuotaPlanKind = "subscription" | "api" | "unknown";
export type ProviderQuotaSourceKind =
  | "chatgpt_plan"
  | "zai_usage_query"
  | "provider_quota";
export type ProviderQuotaReasonCode =
  | "provider_quota_pending"
  | "provider_quota_not_offered"
  | "provider_quota_fetch_failed"
  | "provider_timeout"
  | "provider_response_malformed"
  | "provider_rpc_failure"
  | "provider_temporary_failure";

export interface ButlerUsageWindow {
  id: "hours_5" | "days_7" | "days_30";
  requests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}
export interface ButlerUsageView {
  account: "chatgpt_plan";
  windows: ButlerUsageWindow[];
  asOf: string;
}
export interface ProviderQuotaResultView {
  estimated?: boolean;
  planUsage?: { state: "in_use" | "limit_reached"; resetsAt: string | null } | null;
  credits?: { hasCredits: boolean | null; unlimited: boolean | null; balance: string | null } | null;
  available: boolean;
  stale: boolean;
  sourceKind: ProviderQuotaSourceKind;
  sourceId: string;
  planKind: ProviderQuotaPlanKind;
  planName: string | null;
  windows: Array<{
    id: string;
    usedPercent: number | null;
    remainingPercent: number | null;
    windowDurationMins: number | null;
    resetsAt: string | null;
    expiresAt: string | null;
  }>;
  fetchedAt: string | null;
  reason: {
    code: ProviderQuotaReasonCode;
    message: string;
  } | null;
}

export interface NewChatBriefingSuggestion {
  id: string;
  title: string;
  description: string;
  text: string;
  /** A template the user finishes: it fills the composer instead of sending. */
  template?: boolean;
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

export interface ProjectDashboardPreferences {
  revision: number;
  pinnedSourceRefs: Array<{ kind: string; id: string; revision: string }>;
  /** Absent from older gateways: `inherit`. */
  wallpaper?: ProjectWallpaper;
}

/** `PATCH /projects/:id/dashboard/preferences`: revision-checked, at least one field. */
export interface ProjectDashboardPreferencesPatch {
  expectedRevision: number;
  description?: string;
  pinnedSourceRefs?: ProjectDashboardPreferences["pinnedSourceRefs"];
  wallpaper?: ProjectWallpaper;
}

export interface ProjectDashboardView {
  briefing?: import("../../../shared/app-contracts.ts").DashboardBriefingView;
  description?: string | null;
  preferences?: ProjectDashboardPreferences;
  overview?: import("../../../shared/app-contracts.ts").DashboardOverview;
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
  /** Short-lived `url` with `?expires=..&signature=..` for token-less loads. */
  signed_url?: string;
  size_bytes?: number;
  created_at: string;
  open_action?: "route" | "unsupported" | string;
  source_label?: string | null;
  deliverable?: boolean;
  /** Library versions of a deliverable, newest first. */
  revisions?: ArtifactRevision[];
}

export interface ArtifactRevision {
  file: MessageFileRef;
  message?: string | null;
  capturedAt: string;
}

export interface AutomationTargetSummary {
  automation_id: string;
  title: string;
  interval_seconds?: number;
  schedule_type?: string;
  schedule?: CalendarSchedule | null;
  next_run_at?: string | null;
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
  status_reference?: InterfaceTextReference;
  current_activity_reference?: InterfaceTextReference;
  current_activity_title?: string;
  work_blocks?: WorkBlockView[];
  session_id?: string;
  parent_turn_id?: string;
  source_tool_call_id?: string;
  approved_plan_total?: number;
  approved_plan_completed?: number;
  project_id?: string;
  task_id?: string;
  orchestration_id?: string;
  terminal: boolean;
  created_at?: string;
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
  epic_ids?: string[];
  branch_seed?: import("../../../shared/app-contracts.ts").SessionBranchSeed;
  session_id?: string;
  turn_state?: string;
  latest_progress?: TurnProgressSnapshot;
  latest_turn_cancellable?: boolean;
  latest_turn_subsession_result?: {
    relation_id: string;
    result_id: string;
    safe_title: string;
  };
  branch_info?: {
    available?: boolean;
    workspace_mode?: "git" | "folder" | "none" | "unknown";
    branch_name?: string;
    safe_status?: string;
    safe_error_code?: string;
    workspace_binding?: "project" | "session_worktree" | "session_folder";
    workspace_label?: string;
    /** The moved working folder (`session_folder`). */
    workspace_path?: string;
    workspace_status?: "available" | "unavailable";
    dirty?: boolean;
  };
  context_details?: ContextDetailsView;
  artifacts?: SessionArtifactSummary[];
  automation_targets?: AutomationTargetSummary[];
  skills_used?: string[];
  worker_activity?: WorkerActivitySummary[];
  work_streams?: WorkStreamSummary[];
  steward_children?: StewardSessionSummaryView[];
}

export interface TimelineEvent {
  id?: number;
  type: string;
  created_at?: string;
  payload?: {
    progress?: UpdateProgressView;
    message?: MessageRecord;
    segment_completed?: boolean;
    turn?: {
      id: string;
      chat_id: string;
      state: string;
      safe_status_label?: string;
      updated_at?: string;
      execution_controls?: SessionViewTurn["execution_controls"];
    };
    message_id?: string;
    chat_id?: string;
    role?: MessageRecord["role"];
    session_id?: string;
    child_session_id?: string;
    session?: unknown;
    turn_id?: string;
    state?: string;
    safe_status_label?: string;
    row?: ProgressRow;
    event?: AgentTurnEvent;
    event_id?: string;
    /** `settings.updated`: the changed settings subset. */
    settings?: Record<string, unknown>;
    /** Ephemeral `turn.thinking` display summary, scoped to one model round. */
    round_id?: string;
    stream_id?: string;
    line?: string | null;
    summary?: string;
    tainted?: boolean;
    site?: string;
    amount?: string;
    /** `automation.run`: the run's conversation and its safe error code. */
    target_session_id?: string;
    safe_error_code?: string;
  };
}

export type WorkStatusState =
  | "running"
  | "completed"
  | "attention"
  | "operational_action"
  | "operational_interruption";

export interface WorkStatusItemView {
  session_id: string;
  safe_title: string;
  safe_summary: string;
  state: WorkStatusState;
  stage?: "conception" | "planning" | "execution" | "review" | "validation" | "reporting";
  completed_actions: number;
  total_actions: number;
  effect_count: number;
  latest_report_summary?: string;
  recent_artifacts?: string[];
  updated_at: string;
}

export interface WorkStatusView {
  items: WorkStatusItemView[];
  counts: Record<WorkStatusState, number>;
}

/** A Library (서랍) kind; scraps and bookmarks have groups (bookmark groups are its folders). */
export type LibraryKind = "scrap" | "document" | "bookmark" | "output";
/**
 * The Library: the main screen, a kind's full view (`section`), a group in it (`group`: an id or "none"
 * for ungrouped) and a scrap's detail (`item`). Each level is one step up from the next (titlebar back).
 */
export type LibraryView = { kind: "library"; section?: LibraryKind; group?: string; item?: string; doc?: string };

export type AppView =
  | { kind: "browser" }
  | { kind: "history"; from?: "browser" | "settings" }
  | LibraryView
  | { kind: "session" }
  | { kind: "settings"; section: SettingsSectionId }
  | { kind: "automations" }
  | { kind: "automation-detail"; automationId: string }
  | { kind: "project-dashboard"; projectId: string; epicId?: string }
  | { kind: "plan-overview"; projectId: string; planId: string | null };

export interface CommandPaletteResult {
  schedule?: CalendarSchedule | null;
  schedule_type?: string;
  interval_seconds?: number;
  id: string;
  kind: "chat" | "project" | "project_session" | "group" | "automation" | "settings";
  title: string;
  subtitle?: string;
  route: string;
}

export interface AutomationSummary {
  browser_signin?: boolean;
  browser_payment?: boolean;
  id: string;
  title: string;
  target_label: string;
  state: string;
  interval_seconds?: number;
  schedule_type?: string;
  schedule?: CalendarSchedule | null;
  next_run_at?: string | null;
  /** The access the schedule's runs get; it never changes the target conversation's mode. */
  access_mode: AccessMode;
  /** The schedule's own model; absent or null means none is set and runs follow the target chat's model. An update that omits it or sends null leaves it unchanged. */
  model?: string | null;
}

export interface AutomationRunSummary {
  id: string;
  state: string;
  safe_error_code?: string;
  started_at: string;
  /** The turn the run started, once it started one. */
  turn_id?: string;
}

export interface SessionOption {
  id: string;
  label: string;
}

export interface ComposerControls {
  workspaceMode?: "local" | "worktree";
  /** UI target for the existing sender; dashboard remains visible until acceptance. */
  dashboardTarget?: { projectId: string; sessionId?: string; clientMessageId?: string; onSessionCreated?: (id: string) => void };
  contentParts?: import("./messageContent").MessageContent;
  /** UI-only acknowledgement; never serialized into the transport request. */
  onAccepted?: () => void;
  /** Restore a rejected draft when session creation changed the editor identity. */
  onRejected?: (sessionId: string) => void;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  accessMode?: AccessMode;
  planMode?: boolean;
  attachments?: MessageFileRef[];
  queuePolicy?: "send_now" | "enqueue_if_busy";
}

export type Updater<T> = T | ((previous: T) => T);

/**
 * Raw transport shape of the durable `GET /authority-requests` projection.
 * Fields stay `unknown` on purpose: the store normalizer is the only place
 * allowed to narrow them, and it must fail closed on malformed data.
 */
export interface AuthorityRequestsTransportView {
  session_id?: unknown;
  requests?: unknown;
}

/** Raw transport response from a narrow durable authority decision endpoint. */
export interface AuthorityDecisionTransportView {
  request_ref?: unknown;
  decision?: unknown;
  scheduled?: unknown;
}

/** Opaque decision handle. Never renderable outside transport state. */
export type AuthorityRequestRef = string;

/**
 * Narrow read-only UI card for one pending self-session authority request.
 * The card renders `approval` (or, from older agents, `scope` and `reason`);
 * the request reference exists solely as an in-memory React key and narrow
 * decision handle.
 */
export interface AuthorityApprovalCard {
  requestRef: AuthorityRequestRef;
  category: "command" | "reviewed_effect";
  reason: string;
  executable: string;
  commandCount: number;
  /** Legacy Korean display text; kept for older agents and the conversation grant. */
  scope?: { title: string; description: string };
  /** What the request would do, as data the App phrases in its own language. */
  approval?: ApprovalSummary;
  sourceTurnId?: string;
  sourceCallId?: string;
  sourceSessionId?: string;
}

export type ApprovalRisk = "low" | "medium" | "high";

/**
 * The narrowed `approval` of a pending authority request. `actionKind` and
 * target kinds stay open strings: kinds this App does not know fall back to a
 * generic sentence instead of dropping the request.
 */
export interface ApprovalSummary {
  /** Exact local decision facts; do not apply workspace-label normalization. */
  operation?: { tool: string; access: "read_only" | "change"; targets: string[]; command?: string; allow_conversation?: boolean; allow_site?: "signed_in" | "payment"; browser_tab?: string; browser_mode?: "signed_out" | "signed_in"; sign_in_step?: string; wait_reason?: string; browser_steps?: Array<{ action: string; role: string; name: string; frame: string; value_preview?: string | null; addons: string[] }> };
  commandAccess?: "read_only_unisolated";
  /** What a reviewed schedule create sets up: its name, timing and run mode; never its id. */
  schedule?: { title: string; scheduleType: "once" | "interval" | "daily" | "weekdays" | "update"; browserSignin?: boolean; browserPayment?: boolean; time?: string; runAt?: string; startAt?: string; intervalSeconds?: number; accessMode?: AccessMode };
  actionKind: string;
  /** The folder first where there is one, then files, a connector or a named target. */
  targets: ApprovalTarget[];
  count: number;
  /** Up to three concrete items: relative file paths, or the command line as sent. */
  examples: string[];
  /** Explicit safety-cap flags, one per example; absent means complete. */
  examplesTruncated?: boolean[];
  /** As the agent classified it; the App never classifies. */
  risk?: ApprovalRisk;
}

/** One thing a request touches. Never an absolute path. */
export interface ApprovalTarget {
  kind: string;
  /** Relative to the workspace (empty for a folder), `server/tool` or a target name. */
  path: string;
  /** A folder's label as #277 sends it in `path`: `garden`, or `garden/app` inside it. */
  label?: string;
}

export interface ConversationPermissionView {
  grant_ref: string; title: string; description: string;
  capability?: string; target?: string; cwd?: string;
}

/** Server-backed projection bound to the session id it was fetched for. */
export interface AuthorityApprovalProjection {
  sessionId: string;
  cards: AuthorityApprovalCard[];
  permissions?: ConversationPermissionView[];
}

export type IconElement = ReactElement<{ size?: number | "xs" | "sm" | "md" | "lg" | "xl" | "2xl" }>;
export type ChildrenProps = { children?: ReactNode };
import type { InterfaceContentReferences, InterfaceTextReference } from "../../../../../butler-i18n/src/index.ts";

export interface CalendarSchedule {
  kind: "daily" | "weekly";
  time: string;
  weekdays: number[];
  tz: string;
}

export interface UserQuestion {
  /** `text`: a free-text answer with no options. */
  id: string; eyebrow: string; title: string; kind: "single" | "multi" | "text"; allow_custom: boolean;
  /** `skip` and `input` duplicate the card's own Skip and free input; the runtime drops them. */
  options: { id: string; label: string; description?: string; recommended?: boolean; kind?: "answer" | "skip" | "input" }[];
}
export interface PendingUserQuestions {
  request_ref: string; source_turn_id: string; source_session_id: string;
  question_state: "pending" | "deferred";
  category: "ask_user"; questions: { questions: UserQuestion[] };
}
export interface UserQuestionAnswer { id: string; selected: string[]; custom: string | null; skipped: boolean }
export type UserQuestionResponse = { status: "answered"; answers: UserQuestionAnswer[] } | { status: "deferred" };
export interface AnsweredUserQuestions {
  request_ref: string; source_turn_id: string; updated_at: string;
  questions: { questions: UserQuestion[] }; response: UserQuestionResponse;
}
