import { useSyncExternalStore } from "react";
import { Wallpaper, type WallpaperContentRect, type WallpaperSetting } from "@/butler-ds";

export interface ComposerRectChannel {
  get: () => WallpaperContentRect | undefined;
  set: (rect: WallpaperContentRect) => void;
  subscribe: (listener: () => void) => () => void;
}

/** The composer's latest rect, delivered to the wallpaper without re-rendering its page. */
export function createComposerRectChannel(): ComposerRectChannel {
  let rect: WallpaperContentRect | undefined;
  const listeners = new Set<() => void>();
  return {
    get: () => rect,
    set: (next) => { rect = next; for (const listener of listeners) listener(); },
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}

/** Geometry subscriptions stay in the decorative layer rather than re-rendering the page. */
export function ProjectDashboardWallpaper({ wallpaper, column, composer: composerChannel, paperOverlay }: {
  wallpaper: WallpaperSetting;
  column: ComposerRectChannel;
  composer: ComposerRectChannel;
  paperOverlay: number;
}) {
  const composer = useSyncExternalStore(composerChannel.subscribe, composerChannel.get);
  const columnRect = useSyncExternalStore(column.subscribe, column.get);
  return <Wallpaper scope="container" source={wallpaper.source} motion={wallpaper.motion}
    pauseOnBattery={wallpaper.pauseOnBattery} columnRect={columnRect} contentRect2={composer}
    paperOverlay={paperOverlay} dataTestClass="project-dashboard-wallpaper" />;
}
