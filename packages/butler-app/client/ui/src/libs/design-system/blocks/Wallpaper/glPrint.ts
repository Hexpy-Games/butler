// Print modules (`density: true`, e.g. butler.riso-print): their extra uniforms, their noise and the density pass.
import { NO_WALLPAPER_CONTENT_RECT, type WallpaperContentRectUniform } from "./contentRect";
import type { CompiledWallpaperProgram } from "./glProgram";

type Vec4 = readonly [number, number, number, number];

/** The print uniforms of one frame (`u_css`, the drift state and the keep-outs); CSS px unless noted. */
export interface WallpaperPrintFrame {
  /** The canvas's CSS size (`u_css`). */
  css: readonly [number, number];
  /** The ink field's flow clock (`u_flow`). */
  flow: number;
  /** Plate misregistration: the thinking lift plus the focus pulse (`u_lift`). */
  lift: number;
  /** Dot-gain pulse of the done event (`u_pulse`). */
  pulse: number;
  /** New-chat drop: x, y, progress 0..1, strength (0 = none) (`u_drop`). */
  drop: Vec4;
  /** Message column: left, right, top, on 0..1 (`u_col`). */
  col: Vec4;
  /** Composer keep-out, like `u_contentRect` (drawing-buffer px, bottom-left origin; zeros = none) (`u_contentRect2`). */
  contentRect2: WallpaperContentRectUniform;
}

/** A print at rest (stills, static frames): flow 0, no event looks, no column. */
export function restWallpaperPrintFrame(css: readonly [number, number]): WallpaperPrintFrame {
  return { css, flow: 0, lift: 0, pulse: 0, drop: [0, 0, 1, 0], col: [0, 0, 0, 0], contentRect2: NO_WALLPAPER_CONTENT_RECT };
}

/** Uploads the print uniforms a program reads (a pass that does not read one gets a null location, which GL ignores). */
export function uploadWallpaperPrintUniforms(gl: WebGL2RenderingContext, compiled: CompiledWallpaperProgram, print: WallpaperPrintFrame) {
  const uniform = compiled.uniform;
  gl.uniform2f(uniform("u_css"), print.css[0], print.css[1]);
  gl.uniform1f(uniform("u_flow"), print.flow);
  gl.uniform1f(uniform("u_lift"), print.lift);
  gl.uniform1f(uniform("u_pulse"), print.pulse);
  gl.uniform4f(uniform("u_drop"), ...print.drop);
  gl.uniform4f(uniform("u_col"), ...print.col);
  gl.uniform4f(uniform("u_contentRect2"), ...print.contentRect2);
}

/** Density texels per CSS px: 1 per 4 (1/16 of the pixels; diffused when sampled, so invisible). */
export const WALLPAPER_DENSITY_SCALE = 0.25;

/** The density target's size for a canvas of `css` CSS px. */
export function wallpaperDensitySize(css: readonly [number, number]): { width: number; height: number } {
  return { width: Math.max(1, Math.ceil(css[0] * WALLPAPER_DENSITY_SCALE)), height: Math.max(1, Math.ceil(css[1] * WALLPAPER_DENSITY_SCALE)) };
}

/** A drawing-buffer rect scaled into another buffer (the density target). */
export function scaleWallpaperRect(rect: WallpaperContentRectUniform, sx: number, sy: number): WallpaperContentRectUniform {
  return [rect[0] * sx, rect[1] * sy, rect[2] * sx, rect[3] * sy];
}

const PRINT_NOISE_SIZE = 256;
let printNoise: Uint8Array | null = null;

/**
 * The print's own 256x256 RGBA white noise, bound as `u_noiseTexture` for print modules: the approved
 * prototype's xorshift stream verbatim (riso-core.js `noiseTexture`), so the ink field matches the approved print.
 */
export function wallpaperPrintNoiseTexture(): Uint8Array {
  if (printNoise) return printNoise;
  const px = new Uint8Array(PRINT_NOISE_SIZE * PRINT_NOISE_SIZE * 4);
  let s = 0x2f6b1d;
  for (let i = 0; i < px.length; i++) {
    s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; px[i] = s & 255;
  }
  printNoise = px;
  return px;
}

export { PRINT_NOISE_SIZE as WALLPAPER_PRINT_NOISE_SIZE };
