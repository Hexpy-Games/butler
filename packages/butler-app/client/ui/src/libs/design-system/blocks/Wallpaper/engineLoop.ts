// The engine's frame loop for static and animated modules: still frames on change, the capped animation (woken
// on a timer at its frame slots, not every vsync), and day-phase refreshes.
import type { EngineWatchdog } from "./engineWatchdog";
import { measureWallpaperFrame, type WallpaperCanvasBox } from "./measure";
import type { WallpaperRenderer } from "./renderer";
import {
  WALLPAPER_DAY_PHASE_REFRESH_MS, advanceWallpaperClock, nextWallpaperFrameSlot, wallpaperFrameDue, wallpaperFrameMode,
  wallpaperRenderPolicy, wallpaperStillFrameDue, type WallpaperScheduleState,
} from "./scheduler";
import { wallpaperDayPhase } from "./time";
import type { WallpaperContentRect } from "./types";

/** A frame slot this close is waited for with rAF; further ones with a timer, so idle vsyncs never wake the page. */
const RAF_WAKE_WINDOW = 20;
/** A display frame this close before its slot counts as on time (vsync jitter), so it never costs one more rAF. */
const RAF_SLOT_SLACK_MS = 2;

export interface EngineLoopOptions {
  renderer: WallpaperRenderer;
  watchdog: EngineWatchdog;
  seed: number;
  state(): WallpaperScheduleState;
  hasScene(): boolean;
  box(): WallpaperCanvasBox;
  contentRect(): WallpaperContentRect | null;
  /** Drift modules draw their own frames. */
  owned(): boolean;
  drawn(): void;
}

export interface EngineLoop {
  schedule(): void;
  /** Something changed: the next frame draws. */
  invalidate(): void;
  /** Draws the current scene again now. */
  paint(): void;
  hasDrawn(): boolean;
  dispose(): void;
}

export function createEngineLoop(options: EngineLoopOptions): EngineLoop {
  const { renderer, watchdog } = options;
  let dirty = true;
  let frame = 0;
  let wake = 0;
  let refreshTimer = 0;
  let clock = performance.now();
  let lastTick: number | null = null;
  let lastDraw: number | null = null;
  let slot: number | null = null;

  const schedule = () => {
    if (!frame) frame = window.requestAnimationFrame(tick);
  };
  const scheduleSlot = (now: number, maxFps: number) => {
    const wait = slot === null ? 0 : slot + 1000 / maxFps - now;
    if (wait <= RAF_WAKE_WINDOW) return schedule();
    window.clearTimeout(wake);
    wake = window.setTimeout(() => { wake = 0; schedule(); }, wait - RAF_WAKE_WINDOW / 2);
  };
  const armRefresh = () => {
    window.clearTimeout(refreshTimer);
    refreshTimer = 0;
    if (!renderer.usesDayPhase() || wallpaperFrameMode(options.state()) === "animate") return;
    refreshTimer = window.setTimeout(schedule, WALLPAPER_DAY_PHASE_REFRESH_MS);
  };
  const paint = () => {
    const geometry = measureWallpaperFrame(options.box(), renderer.motion(), options.contentRect(), renderer.pixelRatio());
    renderer.draw({ ...geometry, timeMs: clock, dayPhase: wallpaperDayPhase(new Date()), seed: options.seed });
  };
  const draw = (now: number) => {
    paint();
    options.drawn();
    lastDraw = now;
    dirty = false;
    armRefresh();
  };
  function tick(now: number) {
    frame = 0;
    if (options.owned()) return;
    const state = options.state();
    const mode = options.hasScene() ? wallpaperFrameMode(state) : "idle";
    if (mode !== "animate") {
      lastTick = null;
      slot = null;
      if (mode !== "idle" && wallpaperStillFrameDue({ dirty, usesDayPhase: renderer.usesDayPhase(), now, lastDraw })) draw(now);
      return;
    }
    if (lastTick !== null) clock = advanceWallpaperClock(clock, now - lastTick);
    lastTick = now;
    const { maxFps } = wallpaperRenderPolicy(state.moduleMotion);
    const due = wallpaperFrameDue(now + RAF_SLOT_SLACK_MS, slot, maxFps);
    if (dirty || due) {
      // Only a due frame takes a slot: changes drawn between slots never push the cap's grid ahead of the clock.
      if (due) slot = nextWallpaperFrameSlot(now, slot, maxFps);
      if (watchdog.time(() => draw(now))) return;
    }
    scheduleSlot(now, maxFps);
  }

  return {
    schedule,
    invalidate: () => { dirty = true; },
    paint,
    hasDrawn: () => lastDraw !== null,
    dispose() {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(wake);
      window.clearTimeout(refreshTimer);
    },
  };
}
