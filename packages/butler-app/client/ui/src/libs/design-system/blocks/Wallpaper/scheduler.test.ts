/// <reference types="bun" />
import { expect, test } from "bun:test";
import {
  WALLPAPER_DAY_PHASE_REFRESH_MS,
  WALLPAPER_WATCHDOG_RETRY_MS,
  WALLPAPER_WATCHDOG_SLOW_RENDER_MS,
  WALLPAPER_WATCHDOG_SLOW_FRAMES,
  HEALTHY_WATCHDOG,
  advanceWallpaperClock,
  nextWallpaperFrameSlot,
  frameWatchdogRetryMs,
  retryFrameWatchdog,
  stepFrameWatchdog,
  wallpaperCanvasSize,
  wallpaperFrameDue,
  wallpaperFrameMode,
  wallpaperRenderPolicy,
  wallpaperStillFrameDue,
  type WallpaperScheduleState,
} from "./scheduler";

const RUNNING: WallpaperScheduleState = {
  moduleMotion: "animated",
  motion: "auto",
  reducedMotion: false,
  documentHidden: false,
  intersecting: true,
  pauseOnBattery: false,
  onBattery: false,
  degraded: false,
  contextLost: false,
};

test("render policy: animated ≤20fps, DPR ≤1, ≤1.4MP; static renders on change, DPR ≤2, ≤4MP", () => {
  expect(wallpaperRenderPolicy("animated")).toEqual({ maxFps: 20, maxPixelRatio: 1, maxPixels: 1_400_000 });
  expect(wallpaperRenderPolicy("static")).toEqual({ maxFps: 0, maxPixelRatio: 2, maxPixels: 4_000_000 });
});

test("canvas size respects the pixel-ratio cap and the pixel budget", () => {
  const animated = wallpaperRenderPolicy("animated");
  const still = wallpaperRenderPolicy("static");
  expect(wallpaperCanvasSize({ width: 1280, height: 800 }, 2, animated)).toEqual({ width: 1280, height: 800, pixelRatio: 1 });
  expect(wallpaperCanvasSize({ width: 1280, height: 800 }, 1, still)).toEqual({ width: 1280, height: 800, pixelRatio: 1 });
  expect(wallpaperCanvasSize({ width: 1000, height: 800 }, 2, still)).toEqual({ width: 2000, height: 1600, pixelRatio: 2 });
  for (const [css, ratio, policy] of [
    [{ width: 1920, height: 1080 }, 2, animated],
    [{ width: 2560, height: 1440 }, 1, animated],
    [{ width: 1280, height: 800 }, 2, still],
    [{ width: 3840, height: 2160 }, 2, still],
  ] as const) {
    const size = wallpaperCanvasSize(css, ratio, policy);
    expect(size.width * size.height).toBeLessThanOrEqual(policy.maxPixels * 1.005);
    expect(size.pixelRatio).toBeLessThanOrEqual(policy.maxPixelRatio);
    expect(size.width / size.height).toBeCloseTo(css.width / css.height, 2);
  }
  expect(wallpaperCanvasSize({ width: 0.4, height: 0.4 }, 1, animated)).toMatchObject({ width: 2, height: 2 });
});

test("a visible animated module animates, whether or not its window has focus", () => {
  expect(wallpaperFrameMode(RUNNING)).toBe("animate");
  // Another app in front of a visible Butler window is not a pause.
  expect("windowFocused" in RUNNING).toBe(false);
});

test("hidden documents, off-screen canvases and lost contexts render nothing", () => {
  expect(wallpaperFrameMode({ ...RUNNING, documentHidden: true })).toBe("idle");
  expect(wallpaperFrameMode({ ...RUNNING, intersecting: false })).toBe("idle");
  expect(wallpaperFrameMode({ ...RUNNING, contextLost: true })).toBe("idle");
  expect(wallpaperFrameMode({ ...RUNNING, moduleMotion: "static", documentHidden: true })).toBe("idle");
});

test("pauses hold a still frame", () => {
  expect(wallpaperFrameMode({ ...RUNNING, moduleMotion: "static" })).toBe("still");
  expect(wallpaperFrameMode({ ...RUNNING, motion: "paused" })).toBe("still");
  expect(wallpaperFrameMode({ ...RUNNING, reducedMotion: true })).toBe("still");
  expect(wallpaperFrameMode({ ...RUNNING, degraded: true })).toBe("still");
  expect(wallpaperFrameMode({ ...RUNNING, pauseOnBattery: true, onBattery: true })).toBe("still");
  // Battery alone, or the option alone, keeps animating.
  expect(wallpaperFrameMode({ ...RUNNING, onBattery: true })).toBe("animate");
  expect(wallpaperFrameMode({ ...RUNNING, pauseOnBattery: true })).toBe("animate");
});

test("animated frames are capped at the policy fps", () => {
  expect(wallpaperFrameDue(1000, null, 20)).toBe(true);
  expect(wallpaperFrameDue(1049, 1000, 20)).toBe(false);
  expect(wallpaperFrameDue(1050, 1000, 20)).toBe(true);
});

test("frame slots keep the average rate at the cap despite display-frame jitter", () => {
  expect(nextWallpaperFrameSlot(1000, null, 20)).toBe(1000);
  // A late display frame keeps the 50ms grid instead of drifting.
  expect(nextWallpaperFrameSlot(1066.7, 1000, 20)).toBe(1050);
  // After a stall the grid restarts at the current frame.
  expect(nextWallpaperFrameSlot(1400, 1000, 20)).toBe(1400);
  let slot: number | null = null;
  let draws = 0;
  for (let frame = 0; frame <= 600; frame += 1) {
    const now = frame * (1000 / 60) + (frame % 2 ? 0.4 : -0.4);
    if (!wallpaperFrameDue(now, slot, 20)) continue;
    slot = nextWallpaperFrameSlot(now, slot, 20);
    draws += 1;
  }
  expect(draws).toBeGreaterThanOrEqual(199);
  expect(draws).toBeLessThanOrEqual(201);
});

test("still frames render on change, plus every 15 minutes for day-phase modules", () => {
  expect(WALLPAPER_DAY_PHASE_REFRESH_MS).toBe(15 * 60 * 1000);
  expect(wallpaperStillFrameDue({ dirty: true, usesDayPhase: false, now: 10, lastDraw: 5 })).toBe(true);
  expect(wallpaperStillFrameDue({ dirty: false, usesDayPhase: false, now: 10 + WALLPAPER_DAY_PHASE_REFRESH_MS, lastDraw: 5 })).toBe(false);
  expect(wallpaperStillFrameDue({ dirty: false, usesDayPhase: true, now: 5 + WALLPAPER_DAY_PHASE_REFRESH_MS - 1, lastDraw: 5 })).toBe(false);
  expect(wallpaperStillFrameDue({ dirty: false, usesDayPhase: true, now: 5 + WALLPAPER_DAY_PHASE_REFRESH_MS, lastDraw: 5 })).toBe(true);
  expect(wallpaperStillFrameDue({ dirty: false, usesDayPhase: true, now: 5, lastDraw: null })).toBe(true);
});

test("the watchdog degrades after a sustained run of slow renders only, and retries after a growing quiet period", () => {
  let watchdog = HEALTHY_WATCHDOG;
  for (let frame = 1; frame < WALLPAPER_WATCHDOG_SLOW_FRAMES; frame += 1) {
    watchdog = stepFrameWatchdog(watchdog, WALLPAPER_WATCHDOG_SLOW_RENDER_MS + 1);
    expect(watchdog.degraded).toBe(false);
  }
  // One healthy frame resets the streak.
  expect(stepFrameWatchdog(watchdog, 2)).toEqual(HEALTHY_WATCHDOG);
  watchdog = stepFrameWatchdog(watchdog, WALLPAPER_WATCHDOG_SLOW_RENDER_MS + 1);
  expect(watchdog.degraded).toBe(true);
  expect(stepFrameWatchdog(watchdog, 2).degraded).toBe(true);
  expect(frameWatchdogRetryMs(watchdog)).toBe(WALLPAPER_WATCHDOG_RETRY_MS);
  watchdog = retryFrameWatchdog(watchdog);
  expect(watchdog).toEqual({ slowStreak: 0, degraded: false, retries: 1 });
  expect(frameWatchdogRetryMs(watchdog)).toBe(WALLPAPER_WATCHDOG_RETRY_MS * 2);
});

test("the animation clock advances with bounded steps so pauses and stalls never jump", () => {
  expect(advanceWallpaperClock(1000, 50)).toBe(1050);
  expect(advanceWallpaperClock(1000, 60_000)).toBeLessThanOrEqual(1250);
  expect(advanceWallpaperClock(1000, -5)).toBe(1000);
});
