import { resetWallpaperPaint } from "./paintSignal";
import type { WallpaperEngine, WallpaperEngineOptions } from "./engineTypes";
import { createEngineDrift } from "./engineDrift";
import { createEngineLoop } from "./engineLoop";
import { initialWallpaperState } from "./engineState";
import { createEngineWatchdog } from "./engineWatchdog";
import { measureWallpaperFrame, readWallpaperCanvasBox } from "./measure";
import { createWallpaperPresenter } from "./presenter";
import { createWallpaperRenderer } from "./renderer";
import { reportWallpaperRuntimeFailure } from "./runtimeFailure";
import { wallpaperFrameMode, type WallpaperScheduleState } from "./scheduler";
import { watchWallpaperContext, watchWallpaperSignals, type WallpaperSignals } from "./signals";
import type { WallpaperContentRect } from "./types";

export type { WallpaperEngine, WallpaperEngineOptions } from "./engineTypes";

/**
 * Drives one wallpaper canvas: a renderer, image loading with crossfades
 * (presenter) and the contract's scheduler (capped animation, still frames on
 * change, pauses, watchdog, context-loss recovery). Drift modules hand their
 * frames to the drift controller (engineDrift). The canvas box is read once
 * and again on resize, never per frame. Null when WebGL2 is unavailable
 * (reported through onError).
 */
export function createWallpaperEngine(canvas: HTMLCanvasElement, options: WallpaperEngineOptions): WallpaperEngine | null {
  const { onError, transparent } = options;
  const renderer = createWallpaperRenderer(canvas, { onError, transparent });
  if (!renderer) {
    resetWallpaperPaint(canvas, "unsupported");
    onError({ reason: "unsupported", module: "", message: "WebGL2 is unavailable" });
    return null;
  }
  const seed = Math.random();
  let state: WallpaperScheduleState = initialWallpaperState(canvas, renderer.softwareRendering());
  let hasScene = false;
  let contentRect: WallpaperContentRect | null = null;
  let box = readWallpaperCanvasBox(canvas);

  // Too slow to animate: hold the current frame (reported once per scene), then try again after a quiet period.
  const degrade = (first: boolean) => { if (first) reportWallpaperRuntimeFailure(onError, renderer.drawnModule(), "degraded"); update({ degraded: true }); };
  const retry = () => update({ degraded: false });
  const watchdog = createEngineWatchdog({ onDegrade: degrade, onRetry: retry });
  const drift = createEngineDrift({
    canvas, layers: options.driftLayers ?? null, renderer, seed, box: () => box, contentRect: () => contentRect,
    onDrawn: () => presenter.drawn(), onDegrade: degrade, onRetry: retry,
  });
  const loop = createEngineLoop({
    renderer, watchdog, seed, state: () => state, hasScene: () => hasScene, box: () => box, contentRect: () => contentRect,
    owned: drift.owns, drawn: () => presenter.drawn(),
  });
  const redraw = () => {
    loop.invalidate();
    if (drift.owns()) drift.refresh();
    else loop.schedule();
  };
  const update = (patch: Partial<WallpaperScheduleState>) => {
    if (patch.reducedMotion !== undefined && patch.reducedMotion !== state.reducedMotion) loop.invalidate();
    state = { ...state, ...patch };
    drift.sync(state);
    // A drifting print schedules its own frames: no rAF from signal changes (hidden, blur, battery).
    if (!drift.owns()) loop.schedule();
  };
  const presenter = createWallpaperPresenter({
    ...options,
    canvas,
    renderer,
    hasDrawn: () => loop.hasDrawn() || drift.owns(),
    repaint: () => { if (drift.owns()) drift.repaint(); else if (hasScene && loop.hasDrawn() && !state.contextLost) loop.paint(); },
    bufferSize: (motion, pixelRatio) => measureWallpaperFrame(box, motion, null, pixelRatio),
    show(scene) {
      resetWallpaperPaint(canvas, scene ? "pending" : "none");
      hasScene = scene !== null;
      if (scene) renderer.setScene(scene);
      watchdog.reset();
      loop.invalidate();
      state = { ...state, moduleMotion: renderer.motion(), degraded: false };
      drift.shown(hasScene, state);
      update({});
    },
  });

  const stopSignals = watchWallpaperSignals(canvas, (patch: Partial<WallpaperSignals>) => update(patch), () => {
    box = readWallpaperCanvasBox(canvas);
    redraw();
    presenter.refresh();
  }, () => drift.event("focus"));
  const stopContext = watchWallpaperContext(canvas, () => {
    resetWallpaperPaint(canvas, "context-lost");
    reportWallpaperRuntimeFailure(onError, hasScene ? renderer.drawnModule() : null, "context-lost");
    update({ contextLost: true });
  }, () => {
    renderer.restore();
    // The restored context has no textures: upload the images in use again.
    presenter.refresh();
    loop.invalidate();
    update({ contextLost: false });
  });

  return {
    setScene(scene) {
      if (scene?.error) onError(scene.error);
      resetWallpaperPaint(canvas, scene ? "pending" : "none");
      presenter.request(scene);
    },
    setMotion: (motion, pauseOnBattery) => update({ motion, pauseOnBattery }),
    setContentRect(rect) {
      const appeared = (contentRect === null) !== (rect === null);
      contentRect = rect;
      box = readWallpaperCanvasBox(canvas); // A layout change may have moved the canvas too.
      // Only modules that read u_contentRect redraw; an animating one picks it up on its next capped frame. A drifting
      // print picks a moved rect up at its next keyframe (a scrolling rail never redraws it); one appearing or going redraws.
      if (!renderer.usesContentRect() || wallpaperFrameMode(state) === "animate") return;
      if (!drift.owns()) redraw();
      else if (appeared) drift.refresh();
    },
    setContentRect2: (rect) => drift.setContentRect2(rect),
    setColumnRect(rect) {
      box = readWallpaperCanvasBox(canvas);
      drift.setColumn(rect);
    },
    event: (kind) => drift.event(kind),
    dispose() {
      loop.dispose();
      watchdog.dispose();
      drift.dispose();
      presenter.dispose();
      stopSignals();
      stopContext();
      renderer.dispose();
      resetWallpaperPaint(canvas, "disposed");
    },
  };
}
