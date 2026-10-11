// The engine's side of drift modules: the drift controller, its frames drawn through the renderer with the print
// uniforms (keep-outs in the canvas's space), host and visibility from the schedule state, and the keyframe watchdog.
import { wallpaperContentRectUniform } from "./contentRect";
import type { WallpaperEventKind } from "./drift";
import { createDriftController, type DriftColumn, type DriftFrame } from "./driftController";
import { createDriftLayers } from "./driftLayers";
import { createDriftLooks } from "./driftLooks";
import { WALLPAPER_DRIFT_SLOW_KEYFRAMES, wallpaperDriftHidden, wallpaperDriftHost } from "./driftScheduler";
import { createEngineWatchdog } from "./engineWatchdog";
import { measureWallpaperFrame, type WallpaperCanvasBox } from "./measure";
import type { WallpaperRenderer } from "./renderer";
import type { WallpaperScheduleState } from "./scheduler";
import { wallpaperDayPhase } from "./time";
import type { WallpaperContentRect } from "./types";

export interface EngineDriftOptions {
  canvas: HTMLCanvasElement;
  /** The display layers; without them drift modules hold still frames on the canvas. */
  layers: { base: HTMLCanvasElement; top: HTMLCanvasElement } | null;
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
  sync(state: WallpaperScheduleState): void;
  refresh(): void;
  repaint(): void;
  setColumn(rect: WallpaperContentRect | null): void;
  setContentRect2(rect: WallpaperContentRect | null): void;
  event(kind: WallpaperEventKind): void;
  dispose(): void;
}

export function createEngineDrift(options: EngineDriftOptions): EngineDrift {
  const { canvas, layers, renderer, box } = options;
  let column: WallpaperContentRect | null = null;
  let contentRect2: WallpaperContentRect | null = null;
  let scene = false;
  const looks = createDriftLooks();
  const watchdog = createEngineWatchdog({ onDegrade: options.onDegrade, onRetry: options.onRetry, slowFrames: WALLPAPER_DRIFT_SLOW_KEYFRAMES });
  const render = ({ flow, looks: l }: DriftFrame) => {
    if (!renderer.drawable()) return false;
    const current = box();
    const geometry = measureWallpaperFrame(current, "drift", options.contentRect(), renderer.pixelRatio());
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
  const drawLayers = layers ? createDriftLayers(canvas, layers.base, layers.top) : null;
  const controller = drawLayers && createDriftController({
    layers: { ...drawLayers, present: (layer) => { drawLayers.present(layer); if (layer === 0) options.onDrawn(); } },
    looks,
    render,
    timeKeyframe: (draw) => watchdog.time(draw),
    geometry: () => {
      const current = box();
      const keep = options.contentRect();
      return { size: [current.width, current.height], keep: keep ? [keep.x - current.left, keep.y - current.top, keep.width, keep.height] : [] };
    },
  });
  const owns = () => controller !== null && scene && renderer.motion() === "drift";
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
    dispose() {
      watchdog.dispose();
      controller?.deactivate();
      controller?.dispose();
    },
  };
}
