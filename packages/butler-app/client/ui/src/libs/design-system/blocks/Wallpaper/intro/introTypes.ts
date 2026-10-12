import type { DriftLayers } from "../driftLayers";
import type { WallpaperCanvasBox } from "../measure";
import type { WallpaperScene } from "../registry";
import type { WallpaperRenderer } from "../renderer";
import type { WallpaperScheduleState } from "../scheduler";
import type { WallpaperContentRect } from "../types";
import type { WallpaperIntroTimeline } from "./introTimeline";

export interface EngineIntroOptions {
  renderer: WallpaperRenderer;
  layers: DriftLayers | null;
  box(): WallpaperCanvasBox;
  state(): WallpaperScheduleState;
  scene(): WallpaperScene | null;
  /** The card moved (client px): the keep-out of the print, before and after the hand-off. */
  onCard(rect: WallpaperContentRect): void;
  /** After the hand-off: a print beat (a step change, client px) goes to the wallpaper that now holds the canvas. */
  onBeat(from: WallpaperContentRect, to: WallpaperContentRect): void;
  /** A frame is on the canvas. */
  onDrawn(): void;
  /** The intro is over: the canvas goes back to the wallpaper; `seeded`: the base layer holds the dried print. */
  onHandoff(seeded: boolean): void;
}

export interface EngineIntro {
  /** The intro owns the canvas. */
  active(): boolean;
  attach(timeline: WallpaperIntroTimeline | null): void;
  /** A scene arrived or its tone changed. */
  shown(): void;
  /** The schedule state changed (hidden, reduced motion, context). */
  sync(): void;
  resize(): void;
  /** The current frame into the canvas only (a crossfade snapshot). */
  repaint(): void;
  dispose(): void;
}
