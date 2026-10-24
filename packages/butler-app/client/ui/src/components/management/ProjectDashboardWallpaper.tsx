import { useCallback, useMemo, useSyncExternalStore } from "react";
import { Wallpaper, type WallpaperContentRect, type WallpaperSetting } from "@/butler-ds";
import { waitForAncestorMotion } from "@/hooks/ancestorMotion.ts";
import { useElementClientRect } from "@/hooks/useElementClientRect.ts";

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

/**
 * Geometry updates stay in the wallpaper layer, as they do in the chat view.
 * While the shell slides the inspector track, the column and the composer
 * move every frame; their keep-outs commit once, where the motion ends.
 */
export function ProjectDashboardWallpaper({ wallpaper, column, composer: composerChannel, paperOverlay }: {
  wallpaper: WallpaperSetting;
  column: HTMLElement | null;
  composer: ComposerRectChannel;
  paperOverlay: number;
}) {
  const subscribe = useCallback((listener: () => void) => {
    let settling = false;
    let subscribed = true;
    const settled = () => {
      settling = false;
      if (subscribed) listener();
    };
    const unsubscribe = composerChannel.subscribe(() => {
      if (settling) return;
      settling = column !== null && waitForAncestorMotion(column, settled);
      if (!settling) listener();
    });
    return () => { subscribed = false; unsubscribe(); };
  }, [composerChannel, column]);
  const composer = useSyncExternalStore(subscribe, composerChannel.get);
  const rect = useElementClientRect(column, { settleMotion: true });
  const columnRect = useMemo(() => rect ? { x: rect.x, y: rect.y, width: rect.width, height: 0 } : undefined, [rect]);
  return <Wallpaper scope="container" source={wallpaper.source} motion={wallpaper.motion}
    pauseOnBattery={wallpaper.pauseOnBattery} columnRect={columnRect} contentRect2={composer}
    paperOverlay={paperOverlay} dataTestClass="project-dashboard-wallpaper" />;
}
