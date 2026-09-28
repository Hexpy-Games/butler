import { checkWallpaperModule, wallpaperLabelText } from "@/butler-ds";
import { appCopy, getAppLocale } from "./copy.ts";
import { notifyStatus } from "./notifications.ts";
import { createWallpaperModuleStore } from "./wallpaperModuleStore.ts";
import {
  listWallpaperModules,
  readWallpaperModuleImage,
  readWallpaperModuleOverlay,
  readWallpaperModuleShader,
  reportWallpaperModuleStatus,
} from "./wallpaperModules.ts";

/**
 * The app's user wallpaper modules: refreshed on bootstrap, on
 * `wallpaper.modules.updated` and after a reconnect; `WallpaperModulesProvider`
 * hands its registry to every wallpaper and picker.
 */
export const userWallpaperModules = createWallpaperModuleStore({
  list: listWallpaperModules,
  shader: readWallpaperModuleShader,
  overlay: readWallpaperModuleOverlay,
  image: readWallpaperModuleImage,
  report: reportWallpaperModuleStatus,
  check: checkWallpaperModule,
  notifyFailure: ({ id, name }) => {
    const label = name ? wallpaperLabelText(name, getAppLocale()) : id;
    notifyStatus(appCopy.settings.wallpaper.moduleFailed(label), { id: "wallpaper-module", tone: "error" });
  },
});
