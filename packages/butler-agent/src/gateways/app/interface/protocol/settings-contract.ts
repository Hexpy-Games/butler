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
