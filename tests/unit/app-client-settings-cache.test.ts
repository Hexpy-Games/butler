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

test("settings defaults carry the gateway's default wallpaper", () => {
  expect(EMPTY_SETTINGS.wallpaper).toEqual({
    source: {
      kind: "live",
      module: "butler.bloom",
      params: { colors: "monochrome" },
    },
    motion: "auto",
    pauseOnBattery: false,
  });
});

test("settings cached before the wallpaper setting derive it from the legacy keys", () => {
  installLocalStorage();
  const { wallpaper: _wallpaper, ...legacy } = EMPTY_SETTINGS;
  const cache = (value: Record<string, unknown>) =>
    globalThis.localStorage.setItem("butler:settings:v1", JSON.stringify(value));

  cache({ ...legacy, main_screen_theme: "silk" });
  expect(readCachedSettings().wallpaper).toEqual({
    source: { kind: "live", module: "butler.silk" },
    motion: "auto",
    pauseOnBattery: false,
  });

  cache({ ...legacy, main_screen_theme: "none" });
  expect(readCachedSettings().wallpaper.source).toEqual({ kind: "none" });

  cache({
    ...legacy,
    main_screen_theme_preset: "custom",
    main_screen_theme_custom_colors: [
      "#112233", "#445566", "#778899", "#AABBCC", "#DDEEFF", "#010203",
    ],
  });
  expect(readCachedSettings().wallpaper.source).toEqual({
    kind: "live",
    module: "butler.bloom",
    params: {
      colors: ["#112233", "#445566", "#778899", "#aabbcc", "#ddeeff", "#010203"],
    },
  });
});

test("a cached wallpaper setting wins over the legacy keys; a malformed one is ignored", () => {
  const stored = {
    source: { kind: "live", module: "butler.silk", params: { base: "#223344" } },
    motion: "paused",
    pauseOnBattery: true,
  } as const;
  expect(
    settingsWithDefaults({ ...EMPTY_SETTINGS, main_screen_theme: "none", wallpaper: stored }).wallpaper,
  ).toEqual(stored);
  expect(
    settingsWithDefaults({
      ...EMPTY_SETTINGS,
      main_screen_theme: "silk",
      wallpaper: { source: { kind: "live" }, motion: "paused" },
    }).wallpaper,
  ).toEqual({
    source: { kind: "live", module: "butler.silk" },
    motion: "auto",
    pauseOnBattery: false,
  });
});
