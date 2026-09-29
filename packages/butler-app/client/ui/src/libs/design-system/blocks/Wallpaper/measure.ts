import { wallpaperContentRectUniform, type WallpaperContentRectUniform } from "./contentRect";
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
}

/** Reads the canvas's box (a layout read: callers cache it and read again on resize). */
export function readWallpaperCanvasBox(canvas: HTMLCanvasElement): WallpaperCanvasBox {
  const rect = canvas.getBoundingClientRect();
  return { left: rect.left, top: rect.top, width: rect.width || window.innerWidth, height: rect.height || window.innerHeight };
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
  const size = wallpaperCanvasSize(box, window.devicePixelRatio || 1, wallpaperRenderPolicy(motion, pixelRatio));
  return { ...size, contentRect: wallpaperContentRectUniform(contentRect, box, size) };
}
