import type { WallpaperContentRect } from "./types";

/** `u_contentRect` value: x, y, width, height in drawing-buffer px. */
export type WallpaperContentRectUniform = readonly [number, number, number, number];

/** No content area known. */
export const NO_WALLPAPER_CONTENT_RECT: WallpaperContentRectUniform = [0, 0, 0, 0];

/** The canvas's client rect (CSS px). */
export interface WallpaperCanvasClientRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * `u_contentRect`: the content rect (client CSS px) clipped to the canvas, in
 * drawing-buffer px with a bottom-left origin, so modules compare it with
 * `gl_FragCoord.xy` directly. Zeros when unknown, empty or off-canvas.
 */
export function wallpaperContentRectUniform(
  rect: WallpaperContentRect | null | undefined,
  canvas: WallpaperCanvasClientRect,
  buffer: { width: number; height: number },
): WallpaperContentRectUniform {
  if (!rect || canvas.width <= 0 || canvas.height <= 0) return NO_WALLPAPER_CONTENT_RECT;
  const left = Math.max(rect.x - canvas.left, 0);
  const top = Math.max(rect.y - canvas.top, 0);
  const right = Math.min(rect.x + rect.width - canvas.left, canvas.width);
  const bottom = Math.min(rect.y + rect.height - canvas.top, canvas.height);
  // NaN fails both comparisons, so non-finite input lands here too.
  if (!(right > left && bottom > top)) return NO_WALLPAPER_CONTENT_RECT;
  const scaleX = buffer.width / canvas.width;
  const scaleY = buffer.height / canvas.height;
  return [left * scaleX, (canvas.height - bottom) * scaleY, (right - left) * scaleX, (bottom - top) * scaleY];
}
