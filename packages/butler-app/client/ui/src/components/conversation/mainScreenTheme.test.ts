// test-category: race
/// <reference types="bun" />
import { expect, test } from "bun:test";
import type { NavigationView, ProjectWallpaper, SettingsView } from "@/app/types.ts";
import type { WallpaperSetting } from "@/butler-ds";
import { activeChatWallpaper, mainScreenWallpaper, type MainScreenWallpaperSettings } from "./mainScreenTheme";

type LegacyTheme = Pick<SettingsView, "main_screen_theme" | "main_screen_theme_preset" | "main_screen_theme_custom_colors">;

const CUSTOM = ["#112233", "#445566", "#778899", "#AABBCC", "#DDEEFF", "#010203"] as LegacyTheme["main_screen_theme_custom_colors"];

/** Settings from before the `wallpaper` key (an old cache or an old gateway). */
function legacy(overrides: Partial<LegacyTheme> = {}): MainScreenWallpaperSettings {
  return {
    main_screen_theme: "bloom",
    main_screen_theme_preset: "monochrome",
    main_screen_theme_custom_colors: [...CUSTOM] as LegacyTheme["main_screen_theme_custom_colors"],
    ...overrides,
  };
}

const sourceOf = (settings: MainScreenWallpaperSettings) => mainScreenWallpaper(settings).source;

test("the wallpaper setting wins over the legacy keys, motion and battery included", () => {
  const wallpaper: WallpaperSetting = {
    source: { kind: "live", module: "butler.silk", params: { base: "#223344" } },
    motion: "paused",
    pauseOnBattery: true,
  };
  expect(mainScreenWallpaper({ ...legacy({ main_screen_theme: "none" }), wallpaper })).toEqual(wallpaper);
  expect(mainScreenWallpaper({ ...legacy(), wallpaper: { ...wallpaper, source: { kind: "none" } } }).source)
    .toEqual({ kind: "none" });
});

test("a missing or malformed wallpaper setting falls back to the legacy keys with default motion", () => {
  expect(mainScreenWallpaper(legacy({ main_screen_theme: "silk" }))).toEqual({
    source: { kind: "live", module: "butler.silk" },
    motion: "auto",
    pauseOnBattery: false,
  });
  const malformed = { source: { kind: "live" }, motion: "paused", pauseOnBattery: true } as unknown as WallpaperSetting;
  expect(mainScreenWallpaper({ ...legacy({ main_screen_theme: "none" }), wallpaper: malformed })).toEqual({
    source: { kind: "none" },
    motion: "auto",
    pauseOnBattery: false,
  });
});

test("legacy none maps to no wallpaper", () => {
  expect(sourceOf(legacy({ main_screen_theme: "none" }))).toEqual({ kind: "none" });
});

test("legacy silk maps to the silk module with its tone defaults", () => {
  expect(sourceOf(legacy({ main_screen_theme: "silk", main_screen_theme_preset: "aurora" })))
    .toEqual({ kind: "live", module: "butler.silk" });
});

test("legacy bloom presets map to a preset name", () => {
  for (const preset of ["monochrome", "aurora", "bloom", "lavender", "morning"] as const) {
    expect(sourceOf(legacy({ main_screen_theme_preset: preset })))
      .toEqual({ kind: "live", module: "butler.bloom", params: { colors: preset } });
  }
});

test("a legacy custom bloom palette maps to its normalized hex list", () => {
  expect(sourceOf(legacy({ main_screen_theme_preset: "custom" }))).toEqual({
    kind: "live",
    module: "butler.bloom",
    params: { colors: ["#112233", "#445566", "#778899", "#aabbcc", "#ddeeff", "#010203"] },
  });
});

test("invalid legacy custom colors and unknown values fall back to the default bloom", () => {
  const broken = ["#112233", "red"] as unknown as LegacyTheme["main_screen_theme_custom_colors"];
  expect(sourceOf(legacy({ main_screen_theme_preset: "custom", main_screen_theme_custom_colors: broken })))
    .toEqual({ kind: "live", module: "butler.bloom" });
  expect(sourceOf(legacy({ main_screen_theme_preset: "noon" as LegacyTheme["main_screen_theme_preset"] })))
    .toEqual({ kind: "live", module: "butler.bloom" });
  expect(sourceOf(legacy({ main_screen_theme: "curtain" as LegacyTheme["main_screen_theme"] })))
    .toEqual({ kind: "live", module: "butler.bloom", params: { colors: "monochrome" } });
});

test("equal settings keep one wallpaper identity, so the wallpaper never rebuilds on re-render", () => {
  const first = mainScreenWallpaper(legacy({ main_screen_theme_preset: "custom" }));
  // A fresh settings object with a fresh (equal) colors array.
  const second = mainScreenWallpaper(legacy({ main_screen_theme_preset: "custom" }));
  expect(second).toBe(first);
  const changed = mainScreenWallpaper(legacy({ main_screen_theme_preset: "aurora" }));
  expect(changed).not.toBe(first);
  expect(mainScreenWallpaper(legacy({ main_screen_theme_preset: "aurora" }))).toBe(changed);
  const stored: WallpaperSetting = { source: { kind: "none" }, motion: "auto", pauseOnBattery: false };
  expect(mainScreenWallpaper({ ...legacy(), wallpaper: { ...stored } }))
    .toBe(mainScreenWallpaper({ ...legacy(), wallpaper: { ...stored } }));
});

function navigationWith(wallpaper: ProjectWallpaper | undefined): NavigationView {
  const project = {
    id: "p1", display_name: "Demo", last_activity_at: "2026-09-28T00:00:00.000Z", pinned: false, archived: false,
    sessions: [{ id: "s1", kind: "project", project_id: "p1", title: "Chat", last_activity_at: "2026-09-28T00:00:00.000Z", pinned: false, archived: false }],
    ...(wallpaper === undefined ? {} : { wallpaper }),
  };
  return { projects: [project] } as unknown as NavigationView;
}

test("a new chat inside a project shows the project's wallpaper; the global motion preferences stay", () => {
  const wallpaper: WallpaperSetting = { source: { kind: "live", module: "butler.bloom" }, motion: "paused", pauseOnBattery: true };
  const settings = { ...legacy(), wallpaper };
  const silk = { kind: "live", module: "butler.silk" } as const;
  for (const chatId of ["draft:project:p1", "s1"]) {
    expect(activeChatWallpaper(settings, navigationWith(silk), chatId)).toEqual({ ...wallpaper, source: silk });
    expect(activeChatWallpaper(settings, navigationWith({ kind: "none" }), chatId).source).toEqual({ kind: "none" });
    expect(activeChatWallpaper(settings, navigationWith("inherit"), chatId)).toEqual(wallpaper);
    expect(activeChatWallpaper(settings, navigationWith(undefined), chatId)).toEqual(wallpaper);
  }
  // A general new chat, or a project the navigation does not know yet, follows the global setting.
  expect(activeChatWallpaper(settings, navigationWith(silk), "draft:chat")).toEqual(wallpaper);
  expect(activeChatWallpaper(settings, navigationWith(silk), "draft:project:p2")).toEqual(wallpaper);
});
