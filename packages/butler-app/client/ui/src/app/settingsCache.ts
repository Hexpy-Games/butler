import { DEFAULT_WEB_SEARCH_SETTINGS, EMPTY_SETTINGS } from "./constants.ts";
import type { SettingsView } from "./types.ts";

const APP_SETTINGS_CACHE_KEY = "butler:settings:v1";

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeHexColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const color = value.trim().toLocaleLowerCase("en-US");
  return /^#[0-9a-f]{6}$/u.test(color) ? color : null;
}

function normalizeThemeColors(
  value: unknown,
): SettingsView["main_screen_theme_custom_colors"] {
  if (!Array.isArray(value) || value.length !== 6) {
    return EMPTY_SETTINGS.main_screen_theme_custom_colors;
  }
  const colors = value.map(normalizeHexColor);
  return colors.every((color) => color !== null)
    ? (colors as SettingsView["main_screen_theme_custom_colors"])
    : EMPTY_SETTINGS.main_screen_theme_custom_colors;
}

function normalizeThemePreset(
  value: unknown,
): SettingsView["main_screen_theme_preset"] {
  if (
    value === "monochrome" ||
    value === "aurora" ||
    value === "bloom" ||
    value === "lavender" ||
    value === "morning" ||
    value === "custom"
  ) {
    return value;
  }
  return EMPTY_SETTINGS.main_screen_theme_preset;
}

function normalizeMainScreenTheme(
  value: unknown,
): SettingsView["main_screen_theme"] {
  if (value === "curtain") return "silk";
  return value === "none" || value === "bloom" || value === "silk"
    ? value
    : EMPTY_SETTINGS.main_screen_theme;
}

function normalizeDesktopNotifications(
  value: unknown,
): SettingsView["desktop_notifications"] {
  const notifications = isRecord(value) ? value : {};
  return {
    enabled:
      typeof notifications.enabled === "boolean"
        ? notifications.enabled
        : EMPTY_SETTINGS.desktop_notifications.enabled,
    assistant_messages:
      typeof notifications.assistant_messages === "boolean"
        ? notifications.assistant_messages
        : EMPTY_SETTINGS.desktop_notifications.assistant_messages,
    task_completions:
      typeof notifications.task_completions === "boolean"
        ? notifications.task_completions
        : EMPTY_SETTINGS.desktop_notifications.task_completions,
  };
}

export function settingsWithDefaults(
  input: Partial<SettingsView> | unknown,
): SettingsView {
  const record = isRecord(input) ? input : {};
  const webSearch = isRecord(record.web_search) ? record.web_search : {};
  const modelFallback = isRecord(record.model_fallback)
    ? {
        enabled:
          typeof record.model_fallback.enabled === "boolean"
            ? record.model_fallback.enabled
            : EMPTY_SETTINGS.model_fallback.enabled,
        models: Array.isArray(record.model_fallback.models)
          ? record.model_fallback.models.filter(
              (model): model is string => typeof model === "string",
            )
          : EMPTY_SETTINGS.model_fallback.models,
      }
    : EMPTY_SETTINGS.model_fallback;
  const colors = normalizeThemeColors(record.main_screen_theme_custom_colors);
  return {
    ...EMPTY_SETTINGS,
    ...(record as Partial<SettingsView>),
    main_screen_theme: normalizeMainScreenTheme(record.main_screen_theme),
    main_screen_theme_preset: normalizeThemePreset(
      record.main_screen_theme_preset,
    ),
    main_screen_theme_custom_colors: colors,
    desktop_notifications: normalizeDesktopNotifications(
      record.desktop_notifications,
    ),
    desktop_tray_enabled:
      typeof record.desktop_tray_enabled === "boolean"
        ? record.desktop_tray_enabled
        : EMPTY_SETTINGS.desktop_tray_enabled,
    web_search: {
      ...DEFAULT_WEB_SEARCH_SETTINGS,
      ...(webSearch as Partial<SettingsView["web_search"]>),
    },
    model_fallback: modelFallback,
  };
}

export function readCachedSettings(
  fallback: SettingsView = EMPTY_SETTINGS,
): SettingsView {
  try {
    const storage = globalThis.localStorage;
    const raw = storage.getItem(APP_SETTINGS_CACHE_KEY);
    return raw ? settingsWithDefaults(JSON.parse(raw)) : fallback;
  } catch {
    return fallback;
  }
}

export function writeCachedSettings(settings: SettingsView): void {
  try {
    globalThis.localStorage.setItem(
      APP_SETTINGS_CACHE_KEY,
      JSON.stringify(settingsWithDefaults(settings)),
    );
  } catch {
    // The cache only prevents visual flicker; storage failures can be ignored.
  }
}
