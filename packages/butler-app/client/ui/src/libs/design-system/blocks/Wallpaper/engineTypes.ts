import type { WallpaperScene } from "./registry";
import type { WallpaperContentRect, WallpaperError, WallpaperImageLoader, WallpaperMotion } from "./types";

export interface WallpaperEngine {
  setScene(scene: WallpaperScene | null): void;
  setMotion(motion: WallpaperMotion, pauseOnBattery: boolean): void;
  /** The main content area (client CSS px) for `u_contentRect`; null when unknown. */
  setContentRect(rect: WallpaperContentRect | null): void;
  dispose(): void;
}

/** What a wallpaper engine takes besides its canvas. */
export interface WallpaperEngineOptions {
  onError: (error: WallpaperError) => void;
  /** Loads image assets; without it, image sources fall back to the default module. */
  imageLoader?: WallpaperImageLoader;
  /** Sibling canvas the crossfade freezes the previous frame on; no crossfade without it. */
  overlay?: HTMLCanvasElement | null;
  /** A see-through canvas for `transparent` modules; fixed for the canvas's life. */
  transparent?: boolean;
  /** Decodes image bytes; defaults to `createImageBitmap` (tests inject a fake). */
  decode?: (blob: Blob) => Promise<ImageBitmap>;
}
