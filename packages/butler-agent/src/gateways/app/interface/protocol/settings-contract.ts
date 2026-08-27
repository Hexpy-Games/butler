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

export interface ModelFallbackSettingsView {
  enabled: boolean;
  models: string[];
}

export interface ModelFallbackSettingsUpdate {
  enabled?: boolean;
  models?: string[];
}

export const WORKER_PROFILE_BUILTIN_JOBS = [
  "coding",
  "research",
  "debug",
  "review",
  "writing",
] as const;

export type WorkerProfileBuiltinJobName =
  (typeof WORKER_PROFILE_BUILTIN_JOBS)[number];

export interface WorkerProfileBuiltinJob {
  kind: "builtin";
  job: WorkerProfileBuiltinJobName;
}

export interface WorkerProfileCustomJob {
  kind: "custom";
  text: string;
}

export type WorkerProfileJob = WorkerProfileBuiltinJob | WorkerProfileCustomJob;

export const DEFAULT_WORKER_PROFILE_ID = "default";

export const MAX_WORKER_PROFILES = 12;

export const WORKER_PROFILE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,47}$/u;

export const WORKER_PROFILE_LABEL_MAX_LENGTH = 64;

export const WORKER_PROFILE_DOMAIN_MAX_LENGTH = 96;

export const WORKER_PROFILE_CUSTOM_JOB_TEXT_MAX_LENGTH = 160;

export const WORKER_PROFILE_MODEL_REF_MAX_LENGTH = 128;

export const WORKER_PROFILE_PROMPT_MAX_LENGTH = 2000;

export const DEFAULT_MAX_SIMULTANEOUS_WORKERS = 10;

export const MAX_SIMULTANEOUS_WORKERS_LIMIT = 10;

export interface WorkerProfile {
  id: string;
  label: string;
  enabled: boolean;
  job: WorkerProfileJob;
  domain?: string;
  model: string;
  reasoning_effort: SettingsView["reasoning_effort"];
  prompt?: string;
}

export interface SettingsView {
  bridge_mode: "local" | "external";
  gateway_profile: "electron";
  server_url: string;
  default_project_workspace_label: string;
  language: "en" | "ko";
  timezone: string;
  model: string;
  reasoning_effort: "none" | "low" | "medium" | "high" | "xhigh" | "max";
  consolidation_model: string;
  consolidation_reasoning_effort: "none" | "low" | "medium" | "high" | "xhigh" | "max";
  effective_consolidation_model: string;
  consolidation_uses_butler_model: boolean;
  context_window_tokens: number;
  worker_profiles: WorkerProfile[];
  max_simultaneous_workers: number;
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
  model_fallback: ModelFallbackSettingsView;
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
  reasoning_effort: "none" | "low" | "medium" | "high" | "xhigh" | "max";
  enabled: boolean;
}

export interface UpdateSettingsRequest {
  server_url?: string;
  language?: SettingsView["language"];
  timezone?: SettingsView["timezone"];
  model?: string;
  reasoning_effort?: SettingsView["reasoning_effort"];
  consolidation_model?: string;
  consolidation_reasoning_effort?: SettingsView["consolidation_reasoning_effort"];
  context_window_tokens?: number;
  worker_profiles?: WorkerProfile[];
  max_simultaneous_workers?: number;
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
  model_fallback?: ModelFallbackSettingsUpdate;
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
