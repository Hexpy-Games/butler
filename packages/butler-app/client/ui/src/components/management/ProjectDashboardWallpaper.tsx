import { useMemo } from "react";
import { Wallpaper, type WallpaperContentRect, type WallpaperSetting } from "@/butler-ds";
import { useElementClientRect } from "@/hooks/useElementClientRect.ts";

/** Geometry updates stay in the wallpaper layer, as they do in the chat view. */
export function ProjectDashboardWallpaper({ wallpaper, column, composer, paperOverlay }: {
  wallpaper: WallpaperSetting;
  column: HTMLElement | null;
  composer?: WallpaperContentRect;
  paperOverlay: number;
}) {
  const rect = useElementClientRect(column);
  const columnRect = useMemo(() => rect ? { x: rect.x, y: rect.y, width: rect.width, height: 0 } : undefined, [rect]);
  return <Wallpaper scope="container" source={wallpaper.source} motion={wallpaper.motion}
    pauseOnBattery={wallpaper.pauseOnBattery} columnRect={columnRect} contentRect2={composer}
    paperOverlay={paperOverlay} dataTestClass="project-dashboard-wallpaper" />;
}
