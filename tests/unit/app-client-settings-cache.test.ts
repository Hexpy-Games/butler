import { afterEach, expect, test } from "bun:test";
import { EMPTY_SETTINGS } from "../../packages/butler-app/client/ui/src/app/constants.ts";
import {
  readCachedSettings,
  settingsWithDefaults,
  writeCachedSettings,
} from "../../packages/butler-app/client/ui/src/app/settingsCache.ts";
import type { SettingsView } from "../../packages/butler-app/client/ui/src/app/types.ts";

const originalLocalStorage = Object.getOwnPropertyDescriptor(
  globalThis,
  "localStorage",
);

afterEach(() => {
  if (originalLocalStorage) {
    Object.defineProperty(globalThis, "localStorage", originalLocalStorage);
  } else {
    Reflect.deleteProperty(globalThis, "localStorage");
  }
});

function installLocalStorage() {
  const storage = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
  });
}

test("settings cache hydrates the saved theme before server settings load", () => {
  installLocalStorage();
  writeCachedSettings({
    ...EMPTY_SETTINGS,
    main_screen_theme: "silk",
    main_screen_theme_preset: "morning",
  });

  expect(readCachedSettings().main_screen_theme).toBe("silk");
  expect(readCachedSettings().main_screen_theme_preset).toBe("morning");
});

test("settings cache maps the legacy curtain theme to silk", () => {
  installLocalStorage();
  globalThis.localStorage.setItem(
    "butler:settings:v1",
    JSON.stringify({
      ...EMPTY_SETTINGS,
      main_screen_theme: "curtain",
    }),
  );

  expect(readCachedSettings().main_screen_theme).toBe("silk");
});

test("settings defaults use the monochrome bloom palette", () => {
  expect(EMPTY_SETTINGS.main_screen_theme).toBe("bloom");
  expect(EMPTY_SETTINGS.main_screen_theme_preset).toBe("monochrome");
  expect(EMPTY_SETTINGS.main_screen_theme_custom_colors).toEqual([
    "#32424d",
    "#555d7c",
    "#485c70",
    "#6a7d9a",
    "#53708d",
    "#434d70",
  ]);
  expect(EMPTY_SETTINGS.desktop_notifications).toEqual({
    enabled: true,
    assistant_messages: true,
    task_completions: true,
  });
  expect(EMPTY_SETTINGS.desktop_tray_enabled).toBe(true);
});

test("settings cache preserves an explicit custom palette draft", () => {
  const settings = settingsWithDefaults({
    ...EMPTY_SETTINGS,
    main_screen_theme_preset: "custom",
    main_screen_theme_custom_colors:
      EMPTY_SETTINGS.main_screen_theme_custom_colors,
  } satisfies SettingsView);

  expect(settings.main_screen_theme_preset).toBe("custom");
});
