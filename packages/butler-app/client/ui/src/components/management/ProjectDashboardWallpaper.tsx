import { Wallpaper, type WallpaperSetting } from "@/butler-ds";
import { useElementClientRect } from "@/hooks/useElementClientRect.ts";

/**
 * The dashboard wallpaper: fills the ManagementPage background (the main
 * pane only) and tells modules where the header panel is so they keep it
 * clear. Its own state, so header measurements re-render only this layer.
 */
export function ProjectDashboardWallpaper({ wallpaper, header }: {
  wallpaper: WallpaperSetting;
  header: HTMLElement | null;
}) {
  const contentRect = useElementClientRect(header);
  return (
    <Wallpaper
      scope="container"
      source={wallpaper.source}
      motion={wallpaper.motion}
      pauseOnBattery={wallpaper.pauseOnBattery}
      contentRect={contentRect}
      dataTestClass="project-dashboard-wallpaper"
    />
  );
}
