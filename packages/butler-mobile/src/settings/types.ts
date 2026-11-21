// Wire shapes mobile settings uses; subset of butler-app/client/ui/src/app/types.ts.

export type ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max";

export type AccessMode = "read_only" | "ask_first" | "ask_except_reads" | "auto" | "full_access";

export type ProfilingMode = "off" | "basic" | "deep";

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

export interface SettingsView {
  browser?: {
    browsing_agent: string;
    auto: { available?: boolean; model: string; effort: ReasoningEffort; rule: "family_sibling" | "provider_preset" | "conversation" };
  };
  recall_mode: "faster" | "accurate";
  recall_judge_model: string;
  proactive_level: "off" | "sometimes" | "often";
  quiet_hours_start: string;
  quiet_hours_end: string;
  consolidation_time: string;
  consolidation_model: string;
  consolidation_reasoning_effort: ReasoningEffort;
  language: "en" | "ko";
  timezone: string;
  model: string;
  reasoning_effort: ReasoningEffort;
  context_window_tokens: number;
  max_simultaneous_workers: number;
  access_mode: AccessMode;
  schedule_access_mode?: AccessMode;
  command_sandbox_enabled?: boolean;
  command_sandbox_available?: boolean;
  plan_mode_default: boolean;
  follow_up_behavior: "queue" | "steer";
  smart_grouping_enabled: boolean;
  show_thinking: boolean;
  web_search: WebSearchSettingsView;
  model_fallback: ModelFallbackSettingsView;
}

export interface WebSearchSettingsView {
  provider: WebSearchProviderSetting;
  reader_backend: WebSearchReaderBackendSetting;
  planning_enabled: boolean;
  planning_default_depth: WebSearchDefaultDepth;
}

export interface ModelFallbackSettingsView {
  enabled: boolean;
  models: string[];
}

export interface AppModelSummary {
  provider_id: string;
  provider_label: string;
  provider_family_id?: string;
  model_id: string;
  model_ref: string;
  display_name: string;
  context_window_tokens?: number;
  default_reasoning_effort: ReasoningEffort;
  reasoning_efforts: ReasoningEffort[];
  reasoning_budget_tokens?: Partial<Record<ReasoningEffort, number>>;
  runtime_supported: boolean;
  availability?: "ready" | "sign_in_required" | "plan_off" | "not_in_plan";
  local_reasoning_budget_ratio?: number;
  registered?: boolean;
  enabled?: boolean;
}

export interface ModelCatalogView {
  providers: Array<{ provider_id: string; provider_label: string }>;
  default_model_ref: string;
  models: AppModelSummary[];
  registered_models?: AppModelSummary[];
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
  preview: string;
  content: string;
}

export interface PersonalizationProfileView {
  butler_nickname: string;
  principal_name: string;
  preferred_address: string;
}

export interface PersonalizationProfileUpdateRequest {
  butler_nickname?: string;
  principal_name?: string;
  preferred_address?: string;
}

export interface PersonalizationProfilingView {
  mode: ProfilingMode;
  extractor_model: string;
  extractor_reasoning_effort?: ReasoningEffort;
}

export interface PersonalizationProfilingUpdateRequest {
  mode?: ProfilingMode;
  extractor_model?: string;
  extractor_reasoning_effort?: ReasoningEffort;
}

export interface PersonalizationProfileMigrationPromptView {
  prompt: string;
}

export interface PersonalizationProfileMigrationResultView {
  profiling_enabled: boolean;
  imported_candidate_count: number;
  promoted_count: number;
  personalization: PersonalizationView;
}

export interface UpdatePersonalizationRequest {
  persona?: string;
  eol?: string;
  response_language?: "en" | "ko";
  profile?: PersonalizationProfileUpdateRequest;
  profiling?: PersonalizationProfilingUpdateRequest;
}

// Desktop: components/settings/memoryTypes.ts.
export interface Instruction {
  handle: string; text: string; revision: string; project_id: string | null;
  duration?: "this chat" | "7 days" | "always"; expires_at?: string | null;
  scope: { kind: "all" | "project" | "session"; project_name?: string | null };
}
export interface MemoryCard {
  kind: string; item_count: number | null; pending_count: number | null;
  allocated_bytes: number | null; content_updated_at: string | null;
  health: { consent_on?: boolean; reclaimable_bytes?: number | null; state?: string };
}
export interface MemoryReceipt {
  kind?: string; project_id?: string; operation_id: string; phase: "preparing" | "removing" | "complete" | "failed" | "cancelled";
  sequence: number; bytes_reclaimed: number;
}
export interface MemoryInventory { revision: number; kinds: MemoryCard[]; operation?: MemoryReceipt }
export interface ProjectMemory {
  project_id: string; summary_bytes?: number | null; conversations?: number;
  instructions?: number; updated_at?: string | null;
}
export interface MemoryProject { ledger_project_id?: string; id: string; display_name: string }
export interface ConsolidationReceipt {
  kind: "consolidation"; operation_id: string; sequence: number;
  phase: "running" | "complete" | "failed"; trigger: "manual" | "scheduled";
}
export interface ConsolidationStatus {
  active?: ConsolidationReceipt | null;
  last_run: { at: string; status: string; message?: string; trigger?: "manual" | "scheduled" } | null;
  time_of_day: string;
}

// Desktop: components/settings/hooks/usePatterns.ts and useInstructions.ts.
export interface NoticedPattern {
  id: string;
  title: string;
  evidence: { count: number; first_at: string; last_at: string };
}
export interface PatternsView { revision: number; patterns: NoticedPattern[] }
export interface InstructionsView { instructions: Instruction[] }
export interface MemoryProjectsView { projects: MemoryProject[] }

// Desktop: app/setupReadiness.ts.
export interface MemoryModelProgress {
  state: "unset" | "off" | "queued" | "downloading" | "verifying" | "ready" | "failed";
  bytes_done: number;
  bytes_total: number;
  reason?: string;
}
export interface SetupReadinessView { memory_model?: MemoryModelProgress }

// Desktop: app/types.ts (only fields read by these screens).
export type UpdateComponentId = "service" | "app";
export interface ComponentUpdateStatus {
  component: UpdateComponentId;
  current_version: string;
  available_version: string;
  update_available: boolean;
  bundled_agent_version: string | null;
  check_state?: "ok" | "unavailable" | "unchecked";
}
export interface UpdateProgressView {
  component: UpdateComponentId;
  stage: "idle" | "checking" | "downloading" | "verifying" | "ready" | "applying" | "restarting" | "failed" | "completed";
  revision: number;
  cancellable: boolean;
  error_code: string | null;
}
export interface UpdateStatusView {
  progress?: UpdateProgressView | null;
  components: ComponentUpdateStatus[];
}
export interface UpdateCancelResult { cancelled: boolean }
export interface UsageTokenBucketView {
  requestCount: number;
  promptTokens: number;
  cachedTokens: number;
  outputTokens: number;
  totalTokens: number;
}
export interface UsageMonitorView {
  previousPeriod: { totalTokens: number } | null;
  model: UsageTokenBucketView;
  providerUsage: {
    providers: Array<{
      providerId: string;
      monthTokens?: number;
      remaining: ProviderQuotaResultView;
    }>;
  };
  cost: { available: boolean; estimatedUsd: number | null };
  generated_at: string;
}
export interface UsageHistoryView {
  lifetimeTokens: number;
  busiestDay: { date: string; tokens: number } | null;
  longestTask: { durationMs: number; sessionId: string; title: string | null } | null;
  longestStreak: { days: number; start: string | null; end: string | null };
  currentStreak: { days: number; start: string | null };
}
export type ProviderQuotaPlanKind = "subscription" | "api" | "unknown";
export type ProviderQuotaReasonCode =
  | "provider_quota_pending" | "provider_quota_not_offered" | "provider_quota_fetch_failed"
  | "provider_timeout" | "provider_response_malformed" | "provider_rpc_failure" | "provider_temporary_failure";
export interface ProviderQuotaResultView {
  planUsage?: { state: "in_use" | "limit_reached"; resetsAt: string | null } | null;
  available: boolean;
  stale: boolean;
  planKind: ProviderQuotaPlanKind;
  planName: string | null;
  windows: Array<{
    id: string;
    remainingPercent: number | null;
    windowDurationMins: number | null;
    resetsAt: string | null;
    expiresAt: string | null;
  }>;
  fetchedAt: string | null;
  reason: { code: ProviderQuotaReasonCode; message: string } | null;
}
// Desktop: components/usage/imageUsageTypes.ts and useImageUsage.ts.
export interface ImageUsageValues { generated: number; edited: number; estimated_usd: number | null; }
export interface ImageUsageView {
  days: number;
  models: (ImageUsageValues & { model_ref: string; display_name: string; provider_id: string })[];
  total: ImageUsageValues;
}
export interface ImageUsageSelection { selected: unknown | null }

// Desktop: app/types.ts.
export interface PaginationView { has_more: boolean }
export interface SystemEventMetric { label: string; value: string | number | boolean }
export interface SystemEventSummary {
  id: string;
  kind: "scheduler_job" | "consolidation_run" | "profile_consolidation";
  title: string;
  status: string;
  occurred_at?: string;
  duration_ms?: number;
  model_ref?: string;
  uses_butler_model?: boolean;
  metrics: SystemEventMetric[];
}
export interface SystemEventListView { events: SystemEventSummary[]; pagination: PaginationView }
export interface ProjectSummary { id: string; display_name: string; last_activity_at: string }
export type ChatKind = "chat" | "project";
export interface SessionSummary {
  id: string;
  kind: ChatKind;
  title: string;
  project_id?: string;
  project?: { id: string; display_name: string };
  last_activity_at: string;
}
export interface ArchiveListView { projects: ProjectSummary[]; sessions: SessionSummary[]; pagination: PaginationView }
export interface AppInfoView { name: string; version: string; repository_url: string; protocol_version: string }
export interface SkillSummaryView { name: string; description: string; file_path: string }
export interface SkillProjectView { id: string; display_name: string; skills: SkillSummaryView[] }
export interface SkillSettingsView { core: SkillSummaryView[]; user: SkillSummaryView[]; projects: SkillProjectView[] }

// Desktop: components/settings/grantRows.ts.
export type GrantScope = "conversation" | "project" | "always";
export type GrantKind = "command" | "fileWrite" | "network" | "tool" | "other";
export interface GrantRef { grant_ref: string; session_id: string }
export interface GrantRecord extends GrantRef {
  capability: string; target: string; cwd: string | null; scope: GrantScope;
  session_title: string | null; project_id: string | null; project_name: string | null;
  workspace_path: string; created_at: string;
}
export interface AuthorityPermissionsView { permissions: GrantRecord[] }
