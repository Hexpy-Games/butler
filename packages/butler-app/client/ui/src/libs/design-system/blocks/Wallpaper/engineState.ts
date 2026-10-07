import type { WallpaperScheduleState } from "./scheduler";
import { readWallpaperSignals } from "./signals";

/** Initial canvas scheduling policy, including the software-renderer fallback. */
export function initialWallpaperState(canvas: HTMLCanvasElement, softwareRendering: boolean): WallpaperScheduleState {
  const state: WallpaperScheduleState = {
    ...readWallpaperSignals(), moduleMotion: "static", motion: "auto", pauseOnBattery: false, degraded: false, contextLost: false, softwareRendering,
  };
  if (state.softwareRendering) canvas.dataset.wallpaperFallback = "software"; // Before the first frame; smokes assert it.
  return state;
}
