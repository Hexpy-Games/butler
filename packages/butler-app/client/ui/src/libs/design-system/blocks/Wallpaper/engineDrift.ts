// The engine's side of drift modules: the drift controller, its frames drawn through the renderer with the print
// uniforms (keep-outs in the canvas's space), host and visibility from the schedule state, and the keyframe watchdog.
import { wallpaperContentRectUniform } from "./contentRect";
import type { WallpaperEventKind } from "./drift";
import { createDriftController, type DriftColumn, type DriftFrame } from "./driftController";
import type { DriftDebugState } from "./driftDebug";
import { createDriftKeepOut } from "./driftKeepOut";
import type { DriftLayers } from "./driftLayers";
import { createDriftLooks } from "./driftLooks";
import { WALLPAPER_DRIFT_SLOW_KEYFRAMES, wallpaperDriftHidden, wallpaperDriftHost } from "./driftScheduler";
import { createEngineWatchdog } from "./engineWatchdog";
import { measureWallpaperFrame, type WallpaperCanvasBox } from "./measure";
import type { WallpaperRenderer } from "./renderer";
import type { WallpaperScheduleState } from "./scheduler";
import { wallpaperDayPhase } from "./time";
import type { WallpaperContentRect } from "./types";

export interface EngineDriftOptions {
  /** The display layers; without them drift modules hold still frames on the canvas. */
  layers: DriftLayers | null;
  /** Something else (the first-run intro) holds the canvas: the drift waits. */
  held(): boolean;
  renderer: WallpaperRenderer;
  box(): WallpaperCanvasBox;
  contentRect(): WallpaperContentRect | null;
  seed: number;
  /** A frame reached the base layer (reveals the first scene after `none`). */
  onDrawn(): void;
  onDegrade(first: boolean): void;
  onRetry(): void;
}

export interface EngineDrift {
  /** The drawn module drifts and the controller owns its frames. */
  owns(): boolean;
  /** A scene was handed to the renderer: start (under `state`'s host), refresh or stop the drift. */
  shown(hasScene: boolean, state: WallpaperScheduleState): void;
  /** The intro let go of the canvas: the base layer holds its last frame, which the first segment dissolves from. */
  handoff(state: WallpaperScheduleState, seeded: boolean): void;
  sync(state: WallpaperScheduleState): void;
  refresh(): void;
  repaint(): void;
  setColumn(rect: WallpaperContentRect | null): void;
  setContentRect2(rect: WallpaperContentRect | null): void;
  event(kind: WallpaperEventKind): void;
  /**
   * A setup card moved from `from` to `to` (client px; the content rect is already `to`): the keep-out eases there on
   * live frames now. `beat`: a step change, which also wakes the print (the focus look), as the intro print beat does.
   */
  setupCard(from: WallpaperContentRect | null, to: WallpaperContentRect, beat: boolean): void;
  debug(): DriftDebugState | null;
  dispose(): void;
}

export function createEngineDrift(options: EngineDriftOptions): EngineDrift {
  const { layers: drawLayers, renderer, box } = options;
  let column: WallpaperContentRect | null = null;
  let contentRect2: WallpaperContentRect | null = null;
  let scene = false;
  const looks = createDriftLooks();
  const keepOut = createDriftKeepOut(options.contentRect);
  // A moving setup keep-out keeps live frames coming like a look tween does.
  const tweens = { ...looks, tweening: () => looks.tweening() || keepOut.moving() };
  const watchdog = createEngineWatchdog({ onDegrade: options.onDegrade, onRetry: options.onRetry, slowFrames: WALLPAPER_DRIFT_SLOW_KEYFRAMES });
  const render = ({ flow, looks: l }: DriftFrame) => {
    if (!renderer.drawable()) return false;
    const current = box();
    const geometry = measureWallpaperFrame(current, "drift", keepOut.current(performance.now()), renderer.pixelRatio());
    const col: DriftColumn = [l.colL, l.colR, l.colT, l.colOn];
    renderer.draw({
      ...geometry, timeMs: 0, dayPhase: wallpaperDayPhase(new Date()), seed: options.seed,
      print: {
        css: [current.width, current.height], flow, lift: l.lift + l.misPulse, pulse: l.gain, drop: [l.dropX, l.dropY, l.dropP, l.dropS], col,
        contentRect2: wallpaperContentRectUniform(contentRect2, current, geometry),
      },
    });
    return true;
  };
  const controller = drawLayers && createDriftController({
    layers: { ...drawLayers, present: (layer) => { drawLayers.present(layer); if (layer === 0) options.onDrawn(); } },
    looks: tweens,
    render,
    timeKeyframe: (draw) => watchdog.time(draw),
    geometry: () => {
      const current = box();
      const keep = keepOut.current(performance.now());
      return { size: [current.width, current.height], keep: keep ? [keep.x - current.left, keep.y - current.top, keep.width, keep.height] : [] };
    },
  });
  const owns = () => controller !== null && scene && renderer.motion() === "drift" && !options.held();
  const sync = (state: WallpaperScheduleState) => {
    if (!controller || !owns()) return;
    controller.setHost(wallpaperDriftHost(state));
    controller.setHidden(wallpaperDriftHidden(state));
  };
  // The column in the canvas's CSS px; recomputed from the client rect when the canvas moves.
  const columnTarget = (): DriftColumn | null => {
    if (!column) return null;
    const current = box();
    return [column.x - current.left, column.x + column.width - current.left, column.y - current.top, 1];
  };

  return {
    owns,
    shown(hasScene, state) {
      scene = hasScene;
      if (!controller) return;
      if (!owns()) { controller.deactivate(); watchdog.reset(); return; }
      sync(state);
      controller.activate();
    },
    handoff(state, seeded) {
      if (!controller || !owns()) return;
      sync(state);
      controller.activate(seeded);
    },
    sync,
    refresh() {
      if (!controller || !owns()) return;
      if (!controller.column(columnTarget(), false)) controller.refresh();
    },
    repaint() {
      controller?.repaint();
    },
    setColumn(rect) {
      column = rect;
      controller?.column(columnTarget(), true);
    },
    setContentRect2(rect) {
      // Like the content rect: a moved composer is picked up at the next keyframe; one appearing or going redraws.
      const appeared = (contentRect2 === null) !== (rect === null);
      contentRect2 = rect;
      if (appeared && owns()) controller?.refresh();
    },
    event(kind) {
      if (owns()) controller?.event(kind);
    },
    setupCard(from, to, beat) {
      if (!controller || !owns()) return;
      const moved = from !== null && keepOut.move(from, to, performance.now());
      // A static print or a hidden window draws the card where it is now.
      if (!controller.animates()) keepOut.clear();
      if (beat) controller.event("focus");
      else if (moved) controller.wake();
    },
    debug: () => controller?.debug() ?? null,
    dispose() {
      watchdog.dispose();
      controller?.deactivate();
      controller?.dispose();
    },
  };
}
