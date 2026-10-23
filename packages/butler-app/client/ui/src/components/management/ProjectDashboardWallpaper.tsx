import { Wallpaper, type WallpaperContentRect, type WallpaperSetting } from "@/butler-ds";
import { useMemo } from "react";
import { useElementClientRect } from "@/hooks/useElementClientRect.ts";

/**
 * The dashboard wallpaper: fills the ManagementPage background (the main
 * pane only) and tells modules where the header panel is so they keep it
 * clear. Its own state, so header measurements re-render only this layer.
 * SCRATCH PROTOTYPE `flat`: the chat view's text-over-wallpaper treatment
 * instead: the content column as `columnRect`, the composer as `contentRect2`
 * and the conversation paper overlay (useConversationWallpaper).
 */
export function ProjectDashboardWallpaper({ wallpaper, header, flat }: {
  wallpaper: WallpaperSetting;
  header: HTMLElement | null;
  flat?: { column: HTMLElement | null; composer?: WallpaperContentRect; paperOverlay: number };
}) {
  const contentRect = useElementClientRect(flat ? null : header);
  const column = useElementClientRect(flat?.column ?? null);
  const columnRect = useMemo(() => column ? { x: column.x, y: column.y, width: column.width, height: 0 } : undefined, [column]);
  return (
    <Wallpaper
      scope="container"
      source={wallpaper.source}
      motion={wallpaper.motion}
      pauseOnBattery={wallpaper.pauseOnBattery}
      contentRect={flat ? undefined : contentRect}
      columnRect={flat ? columnRect : undefined}
      contentRect2={flat?.composer}
      paperOverlay={flat?.paperOverlay}
      dataTestClass="project-dashboard-wallpaper"
    />
  );
}
