import { BUILTIN_WALLPAPERS, resolveWallpaperScene } from "../../blocks/Wallpaper/registry";
import { createWallpaperRenderer } from "../../blocks/Wallpaper/renderer";
import { wallpaperCanvasSize, wallpaperRenderPolicy } from "../../blocks/Wallpaper/scheduler";
import { drawArt, readArtPalette } from "./art";
import type { DecorationOptions } from "./types";

/** Reuses the unmodified coastal module and GPU renderer; no copied shader or extra surface. */
export function createDecorationPainter(canvas: HTMLCanvasElement, options: DecorationOptions, onError: () => void) {
  const coastal = options.theme === "coastal";
  const gpu = coastal ? createWallpaperRenderer(canvas, { onError }) : null;
  const ctx = coastal ? null : canvas.getContext("2d");
  const palette = readArtPalette(canvas);
  let width = 1;
  let height = 1;
  let geometry = { width: 1, height: 1, pixelRatio: 1 };
  if (coastal) {
    const scene = resolveWallpaperScene({ kind: "live", module: "butler.shoreline" }, BUILTIN_WALLPAPERS, options.tone);
    if (gpu && scene) gpu.setScene(scene);
    else onError();
  } else if (!ctx) onError();
  return {
    resize() {
      const rect = canvas.getBoundingClientRect();
      if (width === rect.width && height === rect.height) return false;
      width = Math.max(1, rect.width);
      height = Math.max(1, rect.height);
      geometry = wallpaperCanvasSize({ width, height }, window.devicePixelRatio, wallpaperRenderPolicy("animated"));
      if (ctx) {
        canvas.width = geometry.width;
        canvas.height = geometry.height;
        ctx.setTransform(geometry.pixelRatio, 0, 0, geometry.pixelRatio, 0, 0);
      }
      return true;
    },
    draw(clock: number, pulse: number, phase: number) {
      const strength = options.theme === "characters" && !options.inside ? 1 : 0.5;
      canvas.style.opacity = String(options.intensity * (strength + (coastal ? pulse * 0.05 : 0)));
      if (gpu) gpu.draw({ ...geometry, timeMs: clock, dayPhase: 0.5, seed: 0.23 });
      if (ctx) drawArt(ctx, options, palette, width, height, clock / 1000, pulse, phase);
    },
    restore() { gpu?.restore(); },
    dispose() { gpu?.dispose(); },
  };
}
