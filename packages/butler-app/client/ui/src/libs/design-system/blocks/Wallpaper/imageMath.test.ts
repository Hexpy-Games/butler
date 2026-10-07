// test-category: pure-logic
/// <reference types="bun" />
import { expect, test } from "bun:test";
import {
  WALLPAPER_DARK_DIM_STEP,
  WALLPAPER_IMAGE_BLUR_RADIUS,
  WALLPAPER_THUMBNAIL_EDGE,
  wallpaperImageBrightness,
  wallpaperImageDefaultDim,
  wallpaperImageFit,
  wallpaperImageUniforms,
  wallpaperImageUnit,
  wallpaperImageVariant,
  type WallpaperImageFitTransform,
} from "./imageMath";

/** Image uv of a canvas uv under a fit transform. */
function imageUv(transform: ReturnType<typeof wallpaperImageFit>, u: number, v: number) {
  return [u * transform.scale[0] + transform.offset[0], v * transform.scale[1] + transform.offset[1]];
}

test("cover fills the canvas and crops the overflow around the center", () => {
  // A 2:1 image on a square canvas shows its middle half horizontally.
  const wide = wallpaperImageFit("cover", 2, 1);
  expect(wide).toEqual({ scale: [0.5, 1], offset: [0.25, 0] });
  // A 1:2 image on a square canvas shows its middle half vertically.
  expect(wallpaperImageFit("cover", 0.5, 1)).toEqual({ scale: [1, 0.5], offset: [0, 0.25] });
  // Cover never samples outside the image.
  for (const [u, v] of [[0, 0], [1, 1], [0, 1], [1, 0]] as const) {
    for (const value of imageUv(wallpaperImageFit("cover", 16 / 9, 3 / 4), u, v)) {
      expect(value).toBeGreaterThanOrEqual(-1e-9);
      expect(value).toBeLessThanOrEqual(1 + 1e-9);
    }
  }
});

test("contain shows the whole image and leaves bars outside 0..1", () => {
  // A 2:1 image on a square canvas: full width, bars above and below.
  const wide = wallpaperImageFit("contain", 2, 1);
  expect(wide).toEqual({ scale: [1, 2], offset: [0, -0.5] });
  expect(imageUv(wide, 0.5, 0.25)).toEqual([0.5, 0]);
  expect(imageUv(wide, 0.5, 0.75)).toEqual([0.5, 1]);
  expect(imageUv(wide, 0.5, 0.1)[1]).toBeLessThan(0);
  // A 1:2 image on a square canvas: full height, bars left and right.
  expect(wallpaperImageFit("contain", 0.5, 1)).toEqual({ scale: [2, 1], offset: [-0.5, 0] });
});

test("matching or unknown aspects map the canvas onto the image unchanged", () => {
  const identity: WallpaperImageFitTransform = { scale: [1, 1], offset: [0, 0] };
  expect(wallpaperImageFit("cover", 16 / 9, 16 / 9)).toEqual(identity);
  expect(wallpaperImageFit("contain", 16 / 9, 16 / 9)).toEqual(identity);
  expect(wallpaperImageFit("cover", 0, 1)).toEqual(identity);
  expect(wallpaperImageFit("contain", Number.NaN, 1)).toEqual(identity);
  expect(wallpaperImageFit("cover", 2, 0)).toEqual(identity);
});

test("dim and blur clamp to 0..1; anything else reads as 0", () => {
  expect(wallpaperImageUnit(0.3)).toBe(0.3);
  expect(wallpaperImageUnit(2)).toBe(1);
  expect(wallpaperImageUnit(-1)).toBe(0);
  expect(wallpaperImageUnit(Number.NaN)).toBe(0);
});

test("dim darkens; the dark theme darkens one step more", () => {
  expect(WALLPAPER_DARK_DIM_STEP).toBe(0.2);
  expect(wallpaperImageBrightness(0, false)).toBe(1);
  expect(wallpaperImageBrightness(0.25, false)).toBe(0.75);
  expect(wallpaperImageBrightness(0, true)).toBeCloseTo(0.8, 9);
  expect(wallpaperImageBrightness(0.5, true)).toBeCloseTo(0.4, 9);
  expect(wallpaperImageBrightness(3, false)).toBe(0);
  expect(wallpaperImageBrightness(Number.NaN, false)).toBe(1);
});

test("the mip level anti-aliases a downscaled image and grows with blur", () => {
  const canvas = { width: 1920, height: 1080 };
  // 2 texels per pixel: level 1, no taps.
  expect(wallpaperImageUniforms({ fit: "cover", blur: 0 }, { width: 3840, height: 2160 }, canvas))
    .toEqual({ fit: [1, 1, 0, 0], blur: [0, 0, 1] });
  // Upscaled or 1:1 images read level 0.
  expect(wallpaperImageUniforms({ fit: "cover", blur: 0 }, { width: 960, height: 540 }, canvas).blur).toEqual([0, 0, 0]);
  // Blur 1: radius 4% of the short edge; taps at half the radius, level log2(radius / 2).
  const radius = WALLPAPER_IMAGE_BLUR_RADIUS * 1080;
  const blurred = wallpaperImageUniforms({ fit: "cover", blur: 1 }, { width: 1920, height: 1080 }, canvas);
  expect(blurred.blur[0]).toBeCloseTo(radius / 2 / 1920, 9);
  expect(blurred.blur[1]).toBeCloseTo(radius / 2 / 1080, 9);
  expect(blurred.blur[2]).toBeCloseTo(Math.log2(radius / 2), 9);
  expect(wallpaperImageUniforms({ fit: "cover", blur: 4 }, { width: 1920, height: 1080 }, canvas)).toEqual(blurred);
});

test("blur taps follow the fit: a cropped axis spans less of the image", () => {
  const canvas = { width: 1000, height: 1000 };
  const { fit, blur } = wallpaperImageUniforms({ fit: "cover", blur: 0.5 }, { width: 2000, height: 1000 }, canvas);
  expect(fit).toEqual([0.5, 1, 0.25, 0]);
  const half = (WALLPAPER_IMAGE_BLUR_RADIUS * 0.5 * 1000) / 2;
  expect(blur[0]).toBeCloseTo((half * 0.5) / 1000, 9);
  expect(blur[1]).toBeCloseTo(half / 1000, 9);
});

test("drawing buffers that fit the thumbnail load it; larger ones load the full image", () => {
  expect(WALLPAPER_THUMBNAIL_EDGE).toBe(480);
  expect(wallpaperImageVariant({ width: 480, height: 300 })).toBe("thumbnail");
  expect(wallpaperImageVariant({ width: 300, height: 480 })).toBe("thumbnail");
  expect(wallpaperImageVariant({ width: 481, height: 100 })).toBe("full");
});

test("a new image's default dim follows its luminance: brighter images dim more, on the 0.05 grid, capped at 0.4", () => {
  const dims = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1].map(wallpaperImageDefaultDim);
  expect(dims).toEqual([0, 0, 0, 0.05, 0.1, 0.2, 0.25, 0.3, 0.35, 0.4, 0.4]);
  for (let index = 1; index < dims.length; index += 1) expect(dims[index]!).toBeGreaterThanOrEqual(dims[index - 1]!);
  // Unknown luminance: a middle default.
  expect(wallpaperImageDefaultDim(Number.NaN)).toBe(0.2);
  expect(wallpaperImageDefaultDim(-1)).toBe(0);
  expect(wallpaperImageDefaultDim(7)).toBe(0.4);
});
