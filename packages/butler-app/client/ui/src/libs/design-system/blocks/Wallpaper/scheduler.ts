// Pure scheduling decisions of the wallpaper engine (contract v1 policy).
import type { WallpaperModuleMotion, WallpaperMotion, WallpaperPixelRatioMode } from "./types";

/** Frame cap of animated modules. */
export const WALLPAPER_ANIMATED_FPS = 20;
/** Still frames of modules that read `u_dayPhase` refresh this often. */
export const WALLPAPER_DAY_PHASE_REFRESH_MS = 15 * 60 * 1000;
/**
 * An animated frame whose own render (the draw calls, not the gap since the
 * last frame, which main-thread stalls elsewhere also stretch) takes longer
 * than this counts as slow for the watchdog.
 */
export const WALLPAPER_WATCHDOG_SLOW_RENDER_MS = 50;
/** Consecutive slow animated frames before the watchdog degrades to a still frame. */
export const WALLPAPER_WATCHDOG_SLOW_FRAMES = 8;
/** Quiet period before a degraded scene tries animating again; doubles per retry up to the cap. */
export const WALLPAPER_WATCHDOG_RETRY_MS = 30_000;
const WALLPAPER_WATCHDOG_RETRY_MAX_MS = 8 * 60_000;
/** Largest step of the animation clock, so stalls and resumes never jump. */
export const WALLPAPER_MAX_CLOCK_STEP_MS = 250;

export interface WallpaperRenderPolicy {
  /** 0 = render only on change. */
  maxFps: number;
  maxPixelRatio: number;
  maxPixels: number;
}

const POLICIES: Record<WallpaperModuleMotion, WallpaperRenderPolicy> = {
  animated: { maxFps: WALLPAPER_ANIMATED_FPS, maxPixelRatio: 1, maxPixels: 1_400_000 },
  // Rendered once per change, so a static frame can afford paper-fiber detail.
  static: { maxFps: 0, maxPixelRatio: 2, maxPixels: 4_000_000 },
};

/** The largest pixel ratio of `pixelRatio: "device"` modules (e.g. 1-device-pixel grain), which take no pixel budget. */
const DEVICE_MAX_PIXEL_RATIO = 2;

export function wallpaperRenderPolicy(motion: WallpaperModuleMotion, pixelRatio: WallpaperPixelRatioMode = "default"): WallpaperRenderPolicy {
  const policy = POLICIES[motion];
  return pixelRatio === "device" ? { ...policy, maxPixelRatio: DEVICE_MAX_PIXEL_RATIO, maxPixels: Number.POSITIVE_INFINITY } : policy;
}

export interface WallpaperCanvasSize {
  width: number;
  height: number;
  /** Drawing-buffer pixels per CSS pixel (`u_pixelRatio`). */
  pixelRatio: number;
}

/** Drawing-buffer size: the device ratio capped by the policy, then scaled into the pixel budget. */
export function wallpaperCanvasSize(
  css: { width: number; height: number },
  devicePixelRatio: number,
  policy: WallpaperRenderPolicy,
): WallpaperCanvasSize {
  const baseRatio = Math.min(devicePixelRatio || 1, policy.maxPixelRatio);
  const targetPixels = Math.max(1, css.width * css.height * baseRatio * baseRatio);
  const pixelRatio = Math.min(baseRatio, Math.sqrt(policy.maxPixels / targetPixels) * baseRatio);
  return {
    width: Math.max(2, Math.round(css.width * pixelRatio)),
    height: Math.max(2, Math.round(css.height * pixelRatio)),
    pixelRatio,
  };
}

export interface WallpaperScheduleState {
  moduleMotion: WallpaperModuleMotion;
  motion: WallpaperMotion;
  reducedMotion: boolean;
  /** Minimized, fully occluded or a background tab. Window focus is deliberately not a signal. */
  documentHidden: boolean;
  intersecting: boolean;
  pauseOnBattery: boolean;
  onBattery: boolean;
  /** The frame-time watchdog gave up on animating this scene. */
  degraded: boolean;
  contextLost: boolean;
  /** The context renders in software: animated modules hold still frames (each frame would be read back on the main thread). */
  softwareRendering?: boolean;
}

/** `idle`: draw nothing. `still`: hold one frame, redraw on change. `animate`: capped loop. */
export type WallpaperFrameMode = "idle" | "still" | "animate";

export function wallpaperFrameMode(state: WallpaperScheduleState): WallpaperFrameMode {
  if (state.documentHidden || !state.intersecting || state.contextLost) return "idle";
  const paused = state.moduleMotion === "static" ||
    state.motion === "paused" ||
    state.reducedMotion ||
    state.degraded ||
    state.softwareRendering === true ||
    (state.pauseOnBattery && state.onBattery);
  return paused ? "still" : "animate";
}

export function wallpaperFrameDue(now: number, slot: number | null, maxFps: number): boolean {
  return slot === null || now - slot >= 1000 / maxFps;
}

/** The slot a due frame fills: the next step on the cap's grid, so display-frame jitter never lowers the rate. */
export function nextWallpaperFrameSlot(now: number, slot: number | null, maxFps: number): number {
  const interval = 1000 / maxFps;
  return slot === null || now - slot >= interval * 2 ? now : slot + interval;
}

export function wallpaperStillFrameDue({ dirty, usesDayPhase, now, lastDraw }: {
  dirty: boolean;
  usesDayPhase: boolean;
  now: number;
  lastDraw: number | null;
}): boolean {
  if (dirty) return true;
  if (!usesDayPhase) return false;
  return lastDraw === null || now - lastDraw >= WALLPAPER_DAY_PHASE_REFRESH_MS;
}

export interface FrameWatchdog {
  slowStreak: number;
  degraded: boolean;
  /** Times this scene degraded and was retried. */
  retries: number;
}

export const HEALTHY_WATCHDOG: FrameWatchdog = { slowStreak: 0, degraded: false, retries: 0 };

/** Feeds one animated frame's render time; a sustained run of slow renders degrades until `retryFrameWatchdog`. */
export function stepFrameWatchdog(watchdog: FrameWatchdog, renderMs: number): FrameWatchdog {
  if (watchdog.degraded) return watchdog;
  const slowStreak = renderMs > WALLPAPER_WATCHDOG_SLOW_RENDER_MS ? watchdog.slowStreak + 1 : 0;
  return { ...watchdog, slowStreak, degraded: slowStreak >= WALLPAPER_WATCHDOG_SLOW_FRAMES };
}

/** How long a degraded watchdog stays quiet before `retryFrameWatchdog`. */
export function frameWatchdogRetryMs(watchdog: FrameWatchdog): number {
  return Math.min(WALLPAPER_WATCHDOG_RETRY_MS * 2 ** watchdog.retries, WALLPAPER_WATCHDOG_RETRY_MAX_MS);
}

/** After the quiet period: animate again, remembering the retry. */
export function retryFrameWatchdog(watchdog: FrameWatchdog): FrameWatchdog {
  return { slowStreak: 0, degraded: false, retries: watchdog.retries + 1 };
}

export function advanceWallpaperClock(clockMs: number, gapMs: number): number {
  return clockMs + Math.min(Math.max(0, gapMs), WALLPAPER_MAX_CLOCK_STEP_MS);
}
