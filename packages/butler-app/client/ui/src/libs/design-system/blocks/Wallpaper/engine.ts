import { resetWallpaperPaint } from "./paintSignal";
import type { WallpaperEngine, WallpaperEngineOptions } from "./engineTypes";
import { createDriftLayers } from "./driftLayers";
import { createEngineDiagnostics } from "./engineDiagnostics";
import { createEngineDrift } from "./engineDrift";
import { createEngineIntro } from "./engineIntro";
import { createEngineLoop } from "./engineLoop";
import { initialWallpaperState } from "./engineState";
import { createEngineWatchdog } from "./engineWatchdog";
import { measureWallpaperFrame, readWallpaperCanvasBox } from "./measure";
import { createWallpaperPresenter } from "./presenter";
import { createWallpaperRenderer } from "./renderer";
import { reportWallpaperRuntimeFailure } from "./runtimeFailure";
import { wallpaperFrameMode, type WallpaperScheduleState } from "./scheduler";
import { watchWallpaperContext, watchWallpaperSignals, type WallpaperSignals } from "./signals";
import type { WallpaperScene } from "./registry";
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
  const created = createWallpaperRenderer(canvas, { onError, transparent });
  if (!created) {
    resetWallpaperPaint(canvas, "unsupported");
    onError({ reason: "unsupported", module: "", message: "WebGL2 is unavailable" });
    return null;
  }
  // Transitions of what decides whether the canvas draws, for the app diagnostics (nothing at idle).
  const diagnostics = createEngineDiagnostics(canvas, { state: () => state, intro: () => intro.active(), drift: () => drift.owns() });
  const renderer = diagnostics.count(created);
  const seed = Math.random();
  let state: WallpaperScheduleState = initialWallpaperState(canvas, renderer.softwareRendering());
  let hasScene = false;
  let scene: WallpaperScene | null = null;
  let contentRect: WallpaperContentRect | null = null;
  let box = readWallpaperCanvasBox(canvas);

  // Too slow to animate: hold the current frame (reported once per scene), then try again after a quiet period.
  const degrade = (first: boolean) => { if (first) reportWallpaperRuntimeFailure(onError, renderer.drawnModule(), "degraded"); update({ degraded: true }); };
  const retry = () => update({ degraded: false });
  const watchdog = createEngineWatchdog({ onDegrade: degrade, onRetry: retry });
  const layers = options.driftLayers ? createDriftLayers(canvas, options.driftLayers.base, options.driftLayers.top) : null;
  // The first-run intro holds the canvas until its hand-off; the drift then dissolves from its dried print.
  const intro = createEngineIntro({
    renderer, layers, box: () => box, state: () => state, scene: () => (hasScene ? scene : null),
    onCard: (rect) => engine.setContentRect(rect), onDrawn: () => presenter.drawn(),
    onHandoff: (seeded) => { if (drift.owns()) drift.handoff(state, seeded); else { layers?.hide(); loop.invalidate(); loop.schedule(); } diagnostics.check(); },
  });
  const drift = createEngineDrift({
    layers, held: intro.active, renderer, seed, box: () => box, contentRect: () => contentRect,
    onDrawn: () => presenter.drawn(), onDegrade: degrade, onRetry: retry,
  });
  const loop = createEngineLoop({
    renderer, watchdog, seed, state: () => state, hasScene: () => hasScene, box: () => box, contentRect: () => contentRect,
    owned: () => drift.owns() || intro.active(), drawn: () => presenter.drawn(),
  });
  const redraw = () => {
    loop.invalidate();
    if (intro.active()) intro.resize();
    else if (drift.owns()) drift.refresh();
    else loop.schedule();
  };
  const update = (patch: Partial<WallpaperScheduleState>) => {
    if (patch.reducedMotion !== undefined && patch.reducedMotion !== state.reducedMotion) loop.invalidate();
    state = { ...state, ...patch };
    drift.sync(state);
    intro.sync();
    // A drifting print schedules its own frames: no rAF from signal changes (hidden, blur, battery).
    if (!drift.owns() && !intro.active()) loop.schedule();
    diagnostics.check();
  };
  const presenter = createWallpaperPresenter({
    ...options,
    canvas,
    renderer,
    hasDrawn: () => loop.hasDrawn() || drift.owns() || intro.active(),
    repaint: () => { if (intro.active()) intro.repaint(); else if (drift.owns()) drift.repaint(); else if (hasScene && loop.hasDrawn() && !state.contextLost) loop.paint(); },
    bufferSize: (motion, pixelRatio) => measureWallpaperFrame(box, motion, null, pixelRatio),
    show(next) {
      resetWallpaperPaint(canvas, next ? "pending" : "none");
      hasScene = next !== null;
      scene = next;
      if (next) renderer.setScene(next);
      watchdog.reset();
      loop.invalidate();
      state = { ...state, moduleMotion: renderer.motion(), degraded: false };
      drift.shown(hasScene, state);
      intro.shown();
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

  const engine: WallpaperEngine = {
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
      // The first-run intro reads its card from its timeline.
      if (intro.active() || !renderer.usesContentRect() || wallpaperFrameMode(state) === "animate") return;
      if (!drift.owns()) redraw();
      else if (appeared) drift.refresh();
    },
    setContentRect2: (rect) => drift.setContentRect2(rect),
    setColumnRect(rect) {
      box = readWallpaperCanvasBox(canvas);
      drift.setColumn(rect);
    },
    event: (kind) => drift.event(kind),
    setIntro: (timeline) => { intro.attach(timeline); diagnostics.check(); },
    dispose() {
      diagnostics.dispose();
      intro.dispose();
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
  intro.attach(options.intro ?? null);
  return engine;
}
