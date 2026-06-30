import type { ProviderModelMetadata } from "../../integrations/providers/model-catalog.ts";
import type {
  SettingsView,
  UpdateSettingsRequest,
} from "./protocol.ts";
import {
  normalizeConsolidationModelRef,
  normalizeKnownModelRef,
  normalizeWorkerModelRules,
  positiveTokenCount,
} from "./settings-models.ts";
import { sanitizeWebSearchSettingsUpdate } from "./web-search-settings.ts";

export function sanitizeSettingsUpdate(
  input: UpdateSettingsRequest,
  extraModels: ProviderModelMetadata[] = [],
): UpdateSettingsRequest {
  const output: UpdateSettingsRequest = {};
  if (typeof input.server_url === "string") {
    const value = input.server_url.trim();
    if (/^https?:\/\/[^\s]+$/u.test(value)) output.server_url = value;
  }
  if (input.language === "en" || input.language === "ko")
    output.language = input.language;
  if (typeof input.timezone === "string") {
    const timezone = normalizeTimezone(input.timezone);
    if (timezone) output.timezone = timezone;
  }
  if (typeof input.model === "string") {
    const model = normalizeKnownModelRef(input.model, extraModels);
    if (model) output.model = model;
  }
  if (
    ["none", "low", "medium", "high", "xhigh"].includes(
      String(input.reasoning_effort),
    )
  ) {
    output.reasoning_effort = input.reasoning_effort;
  }
  if (typeof input.consolidation_model === "string") {
    const model = normalizeConsolidationModelRef(
      input.consolidation_model,
      extraModels,
    );
    if (model) output.consolidation_model = model;
  }
  if (
    ["none", "low", "medium", "high", "xhigh"].includes(
      String(input.consolidation_reasoning_effort),
    )
  ) {
    output.consolidation_reasoning_effort =
      input.consolidation_reasoning_effort;
  }
  const contextWindowTokens = positiveTokenCount(input.context_window_tokens);
  if (contextWindowTokens) output.context_window_tokens = contextWindowTokens;
  if (Array.isArray(input.worker_model_rules)) {
    output.worker_model_rules = normalizeWorkerModelRules(
      input.worker_model_rules,
      extraModels,
    );
  }
  if (
    ["full_access", "ask_first", "read_only"].includes(
      String(input.access_mode),
    )
  ) {
    output.access_mode = input.access_mode;
  }
  if (typeof input.plan_mode_default === "boolean")
    output.plan_mode_default = input.plan_mode_default;
  if (
    input.follow_up_behavior === "queue" ||
    input.follow_up_behavior === "steer"
  ) {
    output.follow_up_behavior = input.follow_up_behavior;
  }
  {
    const multilineSendBehavior = normalizeMultilineSendBehavior(
      input.multiline_send_behavior,
    );
    if (multilineSendBehavior)
      output.multiline_send_behavior = multilineSendBehavior;
  }
  if (
    input.appearance_theme === "system" ||
    input.appearance_theme === "light" ||
    input.appearance_theme === "dark"
  ) {
    output.appearance_theme = input.appearance_theme;
  }
  {
    const mainScreenTheme = normalizeMainScreenTheme(input.main_screen_theme);
    if (mainScreenTheme) output.main_screen_theme = mainScreenTheme;
  }
  {
    const preset = normalizeMainScreenThemePreset(
      input.main_screen_theme_preset,
    );
    if (preset) output.main_screen_theme_preset = preset;
  }
  {
    const colors = normalizeMainScreenThemeColors(
      input.main_screen_theme_custom_colors,
    );
    if (colors) output.main_screen_theme_custom_colors = colors;
  }
  if (typeof input.translucent_sidebar === "boolean")
    output.translucent_sidebar = input.translucent_sidebar;
  if (typeof input.diagnostics_enabled === "boolean")
    output.diagnostics_enabled = input.diagnostics_enabled;
  if (
    input.desktop_notifications &&
    typeof input.desktop_notifications === "object"
  ) {
    const notifications = sanitizeDesktopNotificationSettings(
      input.desktop_notifications,
    );
    if (Object.keys(notifications).length > 0)
      output.desktop_notifications = notifications;
  }
  if (typeof input.desktop_tray_enabled === "boolean")
    output.desktop_tray_enabled = input.desktop_tray_enabled;
  if (input.web_search && typeof input.web_search === "object") {
    const webSearch = sanitizeWebSearchSettingsUpdate(input.web_search);
    if (Object.keys(webSearch).length > 0) output.web_search = webSearch;
  }
  return output;
}

export function normalizeDesktopNotificationSettings(
  input: Partial<SettingsView["desktop_notifications"]> | undefined,
): SettingsView["desktop_notifications"] {
  return {
    enabled: input?.enabled === false ? false : true,
    assistant_messages:
      input?.assistant_messages === false ? false : true,
    task_completions:
      input?.task_completions === false ? false : true,
  };
}

export function normalizeTimezone(value: unknown): string {
  const candidate = typeof value === "string" ? value.trim() : "";
  if (candidate) {
    try {
      Intl.DateTimeFormat("en-US", { timeZone: candidate });
      return candidate;
    } catch {
      // Fall through to local timezone or UTC.
    }
  }
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function normalizedMultilineSendBehaviorOrDefault(
  value: unknown,
): SettingsView["multiline_send_behavior"] {
  return (
    normalizeMultilineSendBehavior(value) ?? "modifier_enter_send_enter_newline"
  );
}

export function normalizedMainScreenThemeOrDefault(
  input: unknown,
): SettingsView["main_screen_theme"] {
  return normalizeMainScreenTheme(input) ?? MAIN_SCREEN_THEME_DEFAULT;
}

export function normalizedMainScreenThemePresetOrDefault(
  input: unknown,
  colors: SettingsView["main_screen_theme_custom_colors"] = MAIN_SCREEN_THEME_CUSTOM_COLORS_DEFAULT,
): SettingsView["main_screen_theme_preset"] {
  const preset = normalizeMainScreenThemePreset(input);
  if (preset === "custom" && isMainScreenMonochromeColors(colors)) {
    return "monochrome";
  }
  return preset ?? MAIN_SCREEN_THEME_PRESET_DEFAULT;
}

export function normalizedMainScreenThemeColorsOrDefault(
  input: unknown,
): SettingsView["main_screen_theme_custom_colors"] {
  return (
    normalizeMainScreenThemeColors(input) ??
    MAIN_SCREEN_THEME_CUSTOM_COLORS_DEFAULT
  );
}

function sanitizeDesktopNotificationSettings(
  input: Partial<SettingsView["desktop_notifications"]>,
): Partial<SettingsView["desktop_notifications"]> {
  const output: Partial<SettingsView["desktop_notifications"]> = {};
  if (typeof input.enabled === "boolean") output.enabled = input.enabled;
  if (typeof input.assistant_messages === "boolean")
    output.assistant_messages = input.assistant_messages;
  if (typeof input.task_completions === "boolean")
    output.task_completions = input.task_completions;
  return output;
}

function normalizeMultilineSendBehavior(
  value: unknown,
): SettingsView["multiline_send_behavior"] | undefined {
  if (value === "enter_send_shift_enter_newline")
    return "enter_send_shift_enter_newline";
  if (
    value === "modifier_enter_send_enter_newline" ||
    value === "enter_newline_shift_enter_send"
  ) {
    return "modifier_enter_send_enter_newline";
  }
  return undefined;
}

function normalizeMainScreenTheme(
  input: unknown,
): SettingsView["main_screen_theme"] | undefined {
  if (input === "curtain") return "silk";
  return input === "none" || input === "bloom" || input === "silk"
    ? input
    : undefined;
}

function normalizeMainScreenThemePreset(
  input: unknown,
): SettingsView["main_screen_theme_preset"] | undefined {
  return input === "monochrome" ||
    input === "aurora" ||
    input === "bloom" ||
    input === "lavender" ||
    input === "morning" ||
    input === "custom"
    ? input
    : undefined;
}

function normalizeMainScreenThemeColors(
  input: unknown,
): SettingsView["main_screen_theme_custom_colors"] | undefined {
  if (!Array.isArray(input) || input.length !== 6) return undefined;
  const colors = input.map((value) =>
    typeof value === "string" && /^#[0-9a-f]{6}$/iu.test(value.trim())
      ? value.trim().toLocaleLowerCase("en-US")
      : null,
  );
  return colors.every((value) => value !== null)
    ? (colors as SettingsView["main_screen_theme_custom_colors"])
    : undefined;
}

function isMainScreenMonochromeColors(
  colors: SettingsView["main_screen_theme_custom_colors"],
): boolean {
  return colors.every(
    (color, index) => color === MAIN_SCREEN_THEME_CUSTOM_COLORS_DEFAULT[index],
  );
}

const MAIN_SCREEN_THEME_DEFAULT: SettingsView["main_screen_theme"] = "bloom";
const MAIN_SCREEN_THEME_PRESET_DEFAULT: SettingsView["main_screen_theme_preset"] =
  "monochrome";
const MAIN_SCREEN_THEME_CUSTOM_COLORS_DEFAULT: SettingsView["main_screen_theme_custom_colors"] =
  ["#32424d", "#555d7c", "#485c70", "#6a7d9a", "#53708d", "#434d70"];
