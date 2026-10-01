// Relative (not `@/butler-ds`): like wallpaperSetting.ts, reachable without the UI path aliases.
import type { WallpaperSetting } from "../libs/design-system/blocks/Wallpaper/types.ts";
import type { ProjectSummary } from "./types.ts";
import { parseWallpaperSource } from "./wallpaperSetting.ts";

/**
 * The wallpaper a screen shows (PLAN-LIVE-WALLPAPER-UPGRADE, data model):
 * project screens — the dashboard and a new chat in that project — show the
 * project's source; `inherit`, a missing or a malformed value, and screens
 * outside a project follow the global setting. Motion and battery
 * preferences are always global. An inheriting project returns `global`
 * itself, so its identity is kept.
 */
export function resolveWallpaper(
  global: WallpaperSetting,
  project?: Pick<ProjectSummary, "wallpaper"> | null,
): WallpaperSetting {
  const own = project?.wallpaper;
  if (own === undefined || own === "inherit") return global;
  const source = parseWallpaperSource(own);
  return source ? { ...global, source } : global;
}
