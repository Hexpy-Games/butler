// Scheduling decisions for drift modules (pure): the host state the drift runs under and its frame mode.
import type { DriftHost } from "./drift";
import type { WallpaperScheduleState } from "./scheduler";

/** Touch devices keep one smaller buffer for rest and event frames. */
export const WALLPAPER_DRIFT_TOUCH_PIXELS = 1_200_000;

/** Keyframes in a row slower than the watchdog threshold before a print falls back to a static still. */
export const WALLPAPER_DRIFT_SLOW_KEYFRAMES = 3;

/**
 * The host state of a drifting print (riso spec "Host states"). A static print under reduced motion, the user's
 * pause (or pause on battery), low power or thermal pressure, software GL or a degraded watchdog; paused on its
 * current mix after 10 min of window blur; half speed after 2 min of blur or on battery; else full speed.
 */
export function wallpaperDriftHost(state: WallpaperScheduleState): DriftHost {
  if (state.reducedMotion || state.motion === "paused" || state.constrained || state.degraded || state.softwareRendering === true ||
    (state.pauseOnBattery && state.onBattery)) return "still";
  if (state.windowBlur === 2) return "frozen";
  if (state.windowBlur === 1 || state.onBattery) return "slow";
  return "full";
}

/** Nothing draws: the window is hidden, the canvas off screen, or the context lost. */
export function wallpaperDriftHidden(state: WallpaperScheduleState): boolean {
  return state.documentHidden || !state.intersecting || state.contextLost;
}

/** `drift`: crossfading keyframes. `paused`: held on the current mix. `still`: one static print. `idle`: nothing. */
export type WallpaperDriftFrameMode = "idle" | "still" | "paused" | "drift";

export function wallpaperDriftFrameMode(state: WallpaperScheduleState): WallpaperDriftFrameMode {
  if (wallpaperDriftHidden(state)) return "idle";
  const host = wallpaperDriftHost(state);
  return host === "still" ? "still" : host === "frozen" ? "paused" : "drift";
}
