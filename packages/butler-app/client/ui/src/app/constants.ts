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
  model: "openai/gpt-5.6-sol",
  reasoning_effort: "xhigh",
  consolidation_model: "default",
  consolidation_reasoning_effort: "xhigh",
  effective_consolidation_model: "openai/gpt-5.6-sol",
  consolidation_uses_butler_model: true,
  context_window_tokens: 258_000,
  worker_model_rules: [
    {
      id: "deep_work",
      label: "Deep work",
      condition:
        "Research, feature-level development, architecture, review, and analysis",
      model: "openai/gpt-5.6-sol",
      reasoning_effort: "high",
      enabled: true,
    },
    {
      id: "routine_work",
      label: "Routine work",
      condition:
        "Simple coding, search, local inspection, formatting, and tool calls",
      model: "openai/gpt-5.6-terra",
      reasoning_effort: "medium",
      enabled: true,
    },
  ],
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
  profile_label: "Local Butler",
};

export const EMPTY_MODEL_CATALOG: ModelCatalogView = {
  default_model_ref: "openai/gpt-5.6-sol",
  default_reasoning_effort: "xhigh",
  providers: [],
  models: [
    {
      provider_id: "openai",
      provider_label: "OpenAI",
      model_id: "gpt-5.6-sol",
      model_ref: "openai/gpt-5.6-sol",
      display_name: "GPT-5.6 Sol",
      status: "latest",
      context_window_tokens: 1_050_000,
      max_output_tokens: 128_000,
      default_reasoning_effort: "xhigh",
      reasoning_efforts: ["none", "low", "medium", "high", "xhigh", "max"],
      token_estimator: "openai_tiktoken_o200k",
      runtime_supported: true,
    },
  ],
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
