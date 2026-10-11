import type { WallpaperEventKind } from "./drift";
import type { WallpaperIntroTimeline } from "./intro/introTimeline";
import type { WallpaperScene } from "./registry";
import type { WallpaperContentRect, WallpaperError, WallpaperImageLoader, WallpaperMotion } from "./types";

export interface WallpaperEngine {
  setScene(scene: WallpaperScene | null): void;
  setMotion(motion: WallpaperMotion, pauseOnBattery: boolean): void;
  /** The main content area (client CSS px) for `u_contentRect`; null when unknown. */
  setContentRect(rect: WallpaperContentRect | null): void;
  /** A second, softer keep-out (client CSS px; the composer) for print modules (`u_contentRect2`). */
  setContentRect2(rect: WallpaperContentRect | null): void;
  /** The message column (client CSS px) print modules keep their ink out of (`u_col`); eases over 300 ms. */
  setColumnRect(rect: WallpaperContentRect | null): void;
  /** Fires a drift event (focus, new chat, thinking, done); other modules ignore it. */
  event(kind: WallpaperEventKind): void;
  /** The first-run intro holds the canvas until its timeline hands off; null lets go at once. */
  setIntro(timeline: WallpaperIntroTimeline | null): void;
  dispose(): void;
}

/** What a wallpaper engine takes besides its canvas. */
export interface WallpaperEngineOptions {
  onError: (error: WallpaperError) => void;
  /** Loads image assets; without it, image sources fall back to the default module. */
  imageLoader?: WallpaperImageLoader;
  /** Sibling canvas the crossfade freezes the previous frame on; no crossfade without it. */
  overlay?: HTMLCanvasElement | null;
  /** The two display layers drift modules crossfade on; without them drift modules hold still frames. */
  driftLayers?: { base: HTMLCanvasElement; top: HTMLCanvasElement } | null;
  /** A see-through canvas for `transparent` modules; fixed for the canvas's life. */
  transparent?: boolean;
  /** A first-run intro to play on this canvas from its first frame. */
  intro?: WallpaperIntroTimeline | null;
  /** Decodes image bytes; defaults to `createImageBitmap` (tests inject a fake). */
  decode?: (blob: Blob) => Promise<ImageBitmap>;
}
