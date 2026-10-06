import type { WallpaperEngine, WallpaperEngineOptions } from "./engineTypes";
import { createEngineWatchdog } from "./engineWatchdog";
import { measureWallpaperFrame, readWallpaperCanvasBox } from "./measure";
import { createWallpaperPresenter } from "./presenter";
import { createWallpaperRenderer } from "./renderer";
import { reportWallpaperRuntimeFailure } from "./runtimeFailure";
import { WALLPAPER_DAY_PHASE_REFRESH_MS, advanceWallpaperClock, nextWallpaperFrameSlot, wallpaperFrameDue } from "./scheduler";
import { wallpaperFrameMode, wallpaperRenderPolicy, wallpaperStillFrameDue, type WallpaperScheduleState } from "./scheduler";
import { readWallpaperSignals, watchWallpaperContext, watchWallpaperSignals, type WallpaperSignals } from "./signals";
import { wallpaperDayPhase } from "./time";
import type { WallpaperContentRect } from "./types";

export type { WallpaperEngine, WallpaperEngineOptions } from "./engineTypes";

/**
 * Drives one wallpaper canvas: a renderer, image loading with crossfades
 * (presenter) and the contract's scheduler (capped animation, still frames on
 * change, pauses, watchdog, context-loss recovery). The canvas box is read
 * once and again on resize, never per frame. Null when WebGL2 is unavailable
 * (reported through onError).
 */
export function createWallpaperEngine(canvas: HTMLCanvasElement, options: WallpaperEngineOptions): WallpaperEngine | null {
  const { onError, transparent } = options;
  const renderer = createWallpaperRenderer(canvas, { onError, transparent });
  if (!renderer) {
    onError({ reason: "unsupported", module: "", message: "WebGL2 is unavailable" });
    return null;
  }
  const seed = Math.random();
  const softwareRendering = renderer.softwareRendering();
  if (softwareRendering) canvas.dataset.wallpaperFallback = "software"; // Before the first frame; smokes assert it.
  let state: WallpaperScheduleState = {
    ...readWallpaperSignals(), moduleMotion: "static", motion: "auto", pauseOnBattery: false, degraded: false, contextLost: false, softwareRendering,
  };
  let hasScene = false;
  let contentRect: WallpaperContentRect | null = null;
  let box = readWallpaperCanvasBox(canvas);
  let dirty = true;
  let frame = 0;
  let refreshTimer = 0;
  let clock = performance.now();
  let lastTick: number | null = null;
  let lastDraw: number | null = null;
  let slot: number | null = null;

  const schedule = () => {
    if (!frame) frame = window.requestAnimationFrame(tick);
  };
  const redraw = () => {
    dirty = true;
    schedule();
  };

  const armRefresh = () => {
    window.clearTimeout(refreshTimer);
    refreshTimer = 0;
    if (!renderer.usesDayPhase() || wallpaperFrameMode(state) === "animate") return;
    refreshTimer = window.setTimeout(schedule, WALLPAPER_DAY_PHASE_REFRESH_MS);
  };

  const paint = () => {
    const geometry = measureWallpaperFrame(box, renderer.motion(), contentRect, renderer.pixelRatio());
    renderer.draw({ ...geometry, timeMs: clock, dayPhase: wallpaperDayPhase(new Date()), seed });
  };

  const draw = (now: number) => {
    paint();
    presenter.drawn();
    lastDraw = now;
    dirty = false;
    armRefresh();
  };

  const tick = (now: number) => {
    frame = 0;
    const mode = hasScene ? wallpaperFrameMode(state) : "idle";
    if (mode !== "animate") {
      lastTick = null;
      slot = null;
      if (mode === "still" && wallpaperStillFrameDue({ dirty, usesDayPhase: renderer.usesDayPhase(), now, lastDraw })) draw(now);
      return;
    }
    if (lastTick !== null) clock = advanceWallpaperClock(clock, now - lastTick);
    lastTick = now;
    const { maxFps } = wallpaperRenderPolicy(state.moduleMotion);
    if (dirty || wallpaperFrameDue(now, slot, maxFps)) {
      slot = nextWallpaperFrameSlot(now, slot, maxFps);
      if (watchdog.time(() => draw(now))) return;
    }
    schedule();
  };

  // Too slow to animate: hold the current frame (reported once per scene), then try again after a quiet period.
  const watchdog = createEngineWatchdog({
    onDegrade: (first) => { if (first) reportWallpaperRuntimeFailure(onError, renderer.drawnModule(), "degraded"); update({ degraded: true }); },
    onRetry: () => update({ degraded: false }),
  });

  const update = (patch: Partial<WallpaperScheduleState>) => {
    state = { ...state, ...patch };
    schedule();
  };

  const presenter = createWallpaperPresenter({
    ...options,
    canvas,
    renderer,
    hasDrawn: () => lastDraw !== null,
    repaint: () => { if (hasScene && lastDraw !== null && !state.contextLost) paint(); },
    bufferSize: (motion, pixelRatio) => measureWallpaperFrame(box, motion, null, pixelRatio),
    show(scene) {
      hasScene = scene !== null;
      if (scene) renderer.setScene(scene);
      watchdog.reset();
      dirty = true;
      update({ moduleMotion: renderer.motion(), degraded: false });
    },
  });

  const stopSignals = watchWallpaperSignals(canvas, (patch: Partial<WallpaperSignals>) => update(patch), () => {
    box = readWallpaperCanvasBox(canvas);
    redraw();
    presenter.refresh();
  });
  const stopContext = watchWallpaperContext(canvas, () => {
    reportWallpaperRuntimeFailure(onError, hasScene ? renderer.drawnModule() : null, "context-lost");
    update({ contextLost: true });
  }, () => {
    renderer.restore();
    // The restored context has no textures: upload the images in use again.
    presenter.refresh();
    dirty = true;
    update({ contextLost: false });
  });

  return {
    setScene(scene) {
      if (scene?.error) onError(scene.error);
      presenter.request(scene);
    },
    setMotion(motion, pauseOnBattery) {
      update({ motion, pauseOnBattery });
    },
    setContentRect(rect) {
      contentRect = rect;
      box = readWallpaperCanvasBox(canvas); // A layout change may have moved the canvas too.
      // Only modules that read u_contentRect redraw; animated ones pick it up on the next frame.
      if (renderer.usesContentRect()) redraw();
    },
    dispose() {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(refreshTimer);
      watchdog.dispose();
      presenter.dispose();
      stopSignals();
      stopContext();
      renderer.dispose();
    },
  };
}
