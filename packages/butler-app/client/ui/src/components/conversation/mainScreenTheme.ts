import type { AppView, NavigationView, SettingsView } from "@/app/types.ts";
import { resolveWallpaper } from "@/app/projectWallpaper.ts";
import { legacyWallpaperSetting, parseWallpaperSetting, type LegacyMainScreenTheme } from "@/app/wallpaperSetting.ts";
import { wallpaperSourceKey, type WallpaperSetting } from "@/butler-ds";
import { activeProjectId } from "./composerProjectContext";

/** Settings from an old cache or gateway may lack `wallpaper`. */
export type MainScreenWallpaperSettings = LegacyMainScreenTheme & Partial<Pick<SettingsView, "wallpaper">>;

let last: { key: string; setting: WallpaperSetting } | null = null;

/**
 * The new-chat wallpaper: the `wallpaper` setting (source, motion, battery),
 * or the legacy `main_screen_theme*` keys when it is missing or malformed.
 * Equal settings return the same object, so re-renders keep one identity.
 */
export function mainScreenWallpaper(settings: MainScreenWallpaperSettings): WallpaperSetting {
  const setting = parseWallpaperSetting(settings.wallpaper) ?? legacyWallpaperSetting(settings);
  const key = `${wallpaperSourceKey(setting.source)}|${setting.motion}|${setting.pauseOnBattery}`;
  if (last?.key !== key) last = { key, setting };
  return last.setting;
}

/**
 * The new-chat wallpaper for the active chat: inside a project, that
 * project's wallpaper (`resolveWallpaper`); elsewhere the global one.
 */
export function activeChatWallpaper(
  settings: MainScreenWallpaperSettings,
  navigation: NavigationView,
  activeChatId: string,
): WallpaperSetting {
  const projectId = activeProjectId(navigation, activeChatId);
  const project = projectId ? navigation.projects?.find((item) => item.id === projectId) : undefined;
  return resolveWallpaper(mainScreenWallpaper(settings), project);
}

/**
 * The wallpaper of the place on screen: a project dashboard's, the active
 * chat's (its project's, else the global one), and the global one elsewhere
 * (settings, automations).
 */
export function placeWallpaper(
  settings: MainScreenWallpaperSettings,
  navigation: NavigationView,
  view: AppView,
  activeChatId: string,
): WallpaperSetting {
  if (view.kind === "session") return activeChatWallpaper(settings, navigation, activeChatId);
  if (view.kind !== "project-dashboard") return mainScreenWallpaper(settings);
  const project = navigation.projects?.find((item) => item.id === view.projectId);
  return resolveWallpaper(mainScreenWallpaper(settings), project);
}
