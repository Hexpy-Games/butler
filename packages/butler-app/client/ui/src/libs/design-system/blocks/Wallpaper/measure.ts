import { wallpaperContentRectUniform, type WallpaperContentRectUniform } from "./contentRect";
import { WALLPAPER_DRIFT_TOUCH_PIXELS } from "./driftScheduler";
import { wallpaperCanvasSize, wallpaperRenderPolicy, type WallpaperCanvasSize } from "./scheduler";
import type { WallpaperContentRect, WallpaperModuleMotion, WallpaperPixelRatioMode } from "./types";

export interface WallpaperFrameGeometry extends WallpaperCanvasSize {
  contentRect: WallpaperContentRectUniform;
}

/** The canvas's client box (CSS px); the window's size while it has none. */
export interface WallpaperCanvasBox {
  left: number;
  top: number;
  width: number;
  height: number;
  /** A coarse primary pointer (a touch device): drift modules take a smaller pixel budget. */
  coarse?: boolean;
}

/** Reads the canvas's box (a layout read: callers cache it and read again on resize). */
export function readWallpaperCanvasBox(canvas: HTMLCanvasElement): WallpaperCanvasBox {
  const rect = canvas.getBoundingClientRect();
  const coarse = typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
  return { left: rect.left, top: rect.top, width: rect.width || window.innerWidth, height: rect.height || window.innerHeight, coarse };
}

/**
 * Drawing-buffer size for the canvas's box under the module's render policy
 * (motion and pixel-ratio mode), and the content rect in that buffer
 * (`u_contentRect`).
 */
export function measureWallpaperFrame(
  box: WallpaperCanvasBox,
  motion: WallpaperModuleMotion,
  contentRect: WallpaperContentRect | null,
  pixelRatio: WallpaperPixelRatioMode = "default",
): WallpaperFrameGeometry {
  const policy = wallpaperRenderPolicy(motion, pixelRatio);
  const budget = motion === "drift" && box.coarse ? { ...policy, maxPixels: Math.min(policy.maxPixels, WALLPAPER_DRIFT_TOUCH_PIXELS) } : policy;
  const size = wallpaperCanvasSize(box, window.devicePixelRatio || 1, budget);
  return { ...size, contentRect: wallpaperContentRectUniform(contentRect, box, size) };
}
