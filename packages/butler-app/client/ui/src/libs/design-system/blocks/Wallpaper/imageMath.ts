// Pure math of image wallpapers: fit, blur, dim and which variant to load.
import type { WallpaperImageDim, WallpaperImageFit, WallpaperImageVariant } from "./types";

/** Brightness the dark theme takes off on top of `dim` ("one step darker"). */
export const WALLPAPER_DARK_DIM_STEP = 0.2;
/** Blur radius at `blur: 1`, as a fraction of the canvas's short edge. */
export const WALLPAPER_IMAGE_BLUR_RADIUS = 0.04;
/** Long edge (px) of an asset's thumbnail; drawing buffers that fit it load the thumbnail. */
export const WALLPAPER_THUMBNAIL_EDGE = 480;

export interface WallpaperSize {
  width: number;
  height: number;
}

/** image uv = canvas uv × scale + offset (both with a bottom-left origin). */
export interface WallpaperImageFitTransform {
  scale: [number, number];
  offset: [number, number];
}

/** Default dim of a new image: none up to this average luminance (dark photos stay as they are). */
const DIM_FROM_LUMINANCE = 0.2;
/** Dim per unit of luminance above `DIM_FROM_LUMINANCE`. */
const DIM_PER_LUMINANCE = 0.6;
/** The most a default dims (a white image); users can still go further. */
const DIM_DEFAULT_MAX = 0.4;
/** The dim slider's grid. */
const DIM_STEP = 0.05;
/** Default when the luminance is unknown. */
const DIM_UNKNOWN = 0.2;
/**
 * Dims up to this are not drawn: the extra full-screen pass costs more than
 * the barely visible step is worth (brightness at or above 1 minus this).
 */
export const WALLPAPER_DIM_SKIP = 0.05;

/**
 * Readability default for a new image wallpaper from its average relative
 * luminance (0 black .. 1 white, measured at upload): brighter images dim
 * more. dim = clamp(0.6 × (luminance − 0.2), 0, 0.4) on the 0.05 grid, e.g.
 * 0.2 → 0, 0.5 → 0.2, 0.8 → 0.35, ≥ 0.83 → 0.4. The dark theme dims one step
 * more on its own (`WALLPAPER_DARK_DIM_STEP`).
 */
export function wallpaperImageDefaultDim(luminance: number): number {
  if (Number.isNaN(luminance)) return DIM_UNKNOWN;
  const dim = Math.min(DIM_DEFAULT_MAX, Math.max(0, (luminance - DIM_FROM_LUMINANCE) * DIM_PER_LUMINANCE));
  return Number((Math.round(dim / DIM_STEP) * DIM_STEP).toFixed(2));
}

/** 0..1; anything else (NaN included) reads as 0. */
export function wallpaperImageUnit(value: number): number {
  return value > 0 ? Math.min(1, value) : 0;
}

/**
 * `cover` scales the image to fill the canvas and crops the overflow around
 * the center; `contain` fits it whole, leaving image uv outside 0..1 as bars.
 * Unknown aspects map the canvas onto the image unchanged.
 */
export function wallpaperImageFit(fit: WallpaperImageFit, imageAspect: number, canvasAspect: number): WallpaperImageFitTransform {
  // Displayed image width over canvas width when the image is as tall as the canvas.
  const ratio = imageAspect / canvasAspect;
  if (!(ratio > 0 && Number.isFinite(ratio))) return { scale: [1, 1], offset: [0, 0] };
  const widthLimits = fit === "cover" ? ratio < 1 : ratio > 1;
  // Displayed size in canvas uv units.
  const [width, height] = widthLimits ? [1, 1 / ratio] : [ratio, 1];
  return { scale: [1 / width, 1 / height], offset: [0.5 - 0.5 / width, 0.5 - 0.5 / height] };
}

/**
 * Remaining brightness after `dim` under the drawing module's `imageDim`:
 * `auto` one step lower in the dark theme, `noDarkStep` just `dim`, `none` 1.
 */
export function wallpaperImageBrightness(dim: number, dark: boolean, mode: WallpaperImageDim = "auto"): number {
  if (mode === "none") return 1;
  const brightness = (1 - wallpaperImageUnit(dim)) * (dark && mode === "auto" ? 1 - WALLPAPER_DARK_DIM_STEP : 1);
  // A dim of at most `WALLPAPER_DIM_SKIP` draws no dim pass.
  return brightness >= 1 - WALLPAPER_DIM_SKIP - 1e-6 ? 1 : brightness;
}

/** Uniforms of the built-in image module. */
export interface WallpaperImageUniforms {
  /** Fit transform: scale.xy, offset.xy. */
  fit: readonly [number, number, number, number];
  /** Tap offset in image uv (xy) and the mip level to sample (z). */
  blur: readonly [number, number, number];
}

/**
 * Fit and blur for one frame. The mip level anti-aliases a downscaled image
 * (texels per pixel) and grows with the blur radius; the shader spreads a few
 * taps at half the radius around each pixel to hide the level's blocks.
 */
export function wallpaperImageUniforms(
  image: { fit: WallpaperImageFit; blur: number },
  texture: WallpaperSize,
  canvas: WallpaperSize,
): WallpaperImageUniforms {
  const { scale, offset } = wallpaperImageFit(image.fit, texture.width / texture.height, canvas.width / canvas.height);
  const texelsPerPixel = (scale[0] * texture.width) / canvas.width;
  const radius = wallpaperImageUnit(image.blur) * WALLPAPER_IMAGE_BLUR_RADIUS * Math.min(canvas.width, canvas.height);
  const lod = Math.log2(Math.max(1, texelsPerPixel, (radius / 2) * texelsPerPixel));
  const tap = radius / 2;
  return {
    fit: [scale[0], scale[1], offset[0], offset[1]],
    blur: [(tap * scale[0]) / canvas.width, (tap * scale[1]) / canvas.height, lod],
  };
}

/** The variant a drawing buffer needs: the thumbnail when it fits, else the full image. */
export function wallpaperImageVariant(buffer: WallpaperSize): WallpaperImageVariant {
  return Math.max(buffer.width, buffer.height) <= WALLPAPER_THUMBNAIL_EDGE ? "thumbnail" : "full";
}
