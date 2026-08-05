import type {
  ModelCatalogView,
  NavigationView,
  SettingsView,
  WebSearchSettingsView,
} from "./types.ts";

export const EMPTY_NAVIGATION: NavigationView = {
  chats: [],
  projects: [],
  automations_summary: { total_count: 0, enabled_count: 0 },
  settings_summary: { profile_label: "Local Butler" },
};

export const DEFAULT_WEB_SEARCH_SETTINGS: WebSearchSettingsView = {
  provider: "duckduckgo-html",
  reader_backend: "lightweight",
  api_key_configured: false,
  api_key_env_var: null,
  planning_enabled: true,
  planning_default_depth: "balanced",
};

export const EMPTY_SETTINGS: SettingsView = {
  bridge_mode: "local",
  gateway_profile: "electron",
  server_url: "http://127.0.0.1:18765",
  default_project_workspace_label: "butler-workspace",
  language: "en",
  timezone: "UTC",
  model: "",
  reasoning_effort: "medium",
  consolidation_model: "default",
  consolidation_reasoning_effort: "xhigh",
  effective_consolidation_model: "",
  consolidation_uses_butler_model: true,
  context_window_tokens: 258_000,
  worker_model_rules: [],
  access_mode: "full_access",
  plan_mode_default: false,
  follow_up_behavior: "queue",
  multiline_send_behavior: "modifier_enter_send_enter_newline",
  appearance_theme: "system",
  main_screen_theme: "bloom",
  main_screen_theme_preset: "monochrome",
  main_screen_theme_custom_colors: [
    "#32424d",
    "#555d7c",
    "#485c70",
    "#6a7d9a",
    "#53708d",
    "#434d70",
  ],
  translucent_sidebar: true,
  diagnostics_enabled: false,
  desktop_notifications: {
    enabled: true,
    assistant_messages: true,
    task_completions: true,
  },
  desktop_tray_enabled: true,
  web_search: DEFAULT_WEB_SEARCH_SETTINGS,
  model_fallback: {
    enabled: false,
    models: [],
  },
  profile_label: "Local Butler",
};

export const EMPTY_MODEL_CATALOG: ModelCatalogView = {
  generation: "unresolved",
  default_model_ref: "",
  default_reasoning_effort: "medium",
  providers: [],
  models: [],
  registered_models: [],
  provider_credentials: [],
  worker_model_presets: [],
};

export const ACTIVE_TURN_STATES = new Set([
  "accepted",
  "thinking",
  "streaming",
  "waiting_for_form",
  "waiting_for_tool",
  "cancelling",
  "retrying",
]);
