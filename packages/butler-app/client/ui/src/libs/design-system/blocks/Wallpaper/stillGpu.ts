// The one offscreen WebGL2 context behind every wallpaper still (picker thumbnails) and module check.
import { linkWallpaperModule, type WallpaperModuleProgramsResult } from "./glModule";
import { createWallpaperResources, type WallpaperGpuResources } from "./glResources";
import { drawWallpaperScene } from "./glScene";
import { wallpaperParamUniforms } from "./glsl";
import { loadWallpaperImageBytes } from "./imageCache";
import { resolveWallpaperValues } from "./values";
import type { WallpaperImageScene, WallpaperScene } from "./registry";
import type { WallpaperImageLoader, WallpaperModule } from "./types";

type StillCanvas = OffscreenCanvas | HTMLCanvasElement;

interface StillGpu {
  canvas: StillCanvas;
  gl: WebGL2RenderingContext;
  resources: WallpaperGpuResources;
}

const ATTRIBUTES: WebGLContextAttributes = {
  alpha: false,
  antialias: false,
  depth: false,
  stencil: false,
  preserveDrawingBuffer: true,
  powerPreference: "low-power",
};

// A still is one moment: the module's still clock, midday and a fixed seed keep it stable across renders.
const STILL_FRAME = { pixelRatio: 1, dayPhase: 0.5, seed: 0.5 };
/** Long edge (px) images are decoded at for stills: plenty for a thumbnail, light on the shared context. */
const STILL_IMAGE_EDGE = 960;
/**
 * Width (CSS px at pixel ratio 1) a still is composed at before it is scaled
 * down to its size: modules lay out in screen pixels (dot pitch, text veils),
 * so a thumbnail shows the screen's composition rather than a crop of it.
 */
const STILL_SCREEN_WIDTH = 1440;

/** Side (px) of the one frame a module check draws. */
const PROBE_SIZE = 32;

const NO_LOADER: WallpaperImageLoader = () => Promise.reject(new Error("Stills draw module default images only"));

let shared: StillGpu | null = null;
let revision = 0;

function createCanvas(): StillCanvas | null {
  if (typeof OffscreenCanvas === "function") return new OffscreenCanvas(1, 1);
  return typeof document === "undefined" ? null : document.createElement("canvas");
}

/** The shared context, created on first use and again after a context loss. Wallpaper instances never dispose it. */
function gpu(): StillGpu | null {
  if (shared && !shared.gl.isContextLost()) return shared;
  const canvas = createCanvas();
  const gl = (canvas?.getContext("webgl2", ATTRIBUTES) ?? null) as WebGL2RenderingContext | null;
  shared = canvas && gl ? { canvas, gl, resources: createWallpaperResources(gl) } : null;
  return shared;
}

function encode(canvas: StillCanvas): Promise<Blob> {
  if ("convertToBlob" in canvas) return canvas.convertToBlob({ type: "image/png" });
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("toBlob failed"))), "image/png");
  });
}

/** The drawn frame scaled down to `size` on a 2D canvas (high-quality resampling), then encoded. */
function encodeScaled(source: StillCanvas, size: { width: number; height: number }): Promise<Blob> {
  if (source.width === size.width && source.height === size.height) return encode(source);
  const target = typeof OffscreenCanvas === "function" ? new OffscreenCanvas(size.width, size.height) : document.createElement("canvas");
  target.width = size.width;
  target.height = size.height;
  const context = target.getContext("2d") as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!context) return encode(source);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(source, 0, 0, size.width, size.height);
  return encode(target);
}

function linked({ resources }: StillGpu, module: WallpaperModule): WallpaperModuleProgramsResult {
  return linkWallpaperModule(resources.programs, module, resources.precision).result;
}

/**
 * Compiles and links a module's passes on the shared context (once per
 * source; its stills reuse the programs). Null when WebGL2 is unavailable.
 */
export function compileWallpaperStillProgram(module: WallpaperModule): WallpaperModuleProgramsResult | null {
  const context = gpu();
  return context ? linked(context, module) : null;
}

/** Whether the shared context exists (WebGL2 is available), creating it on first use. */
export function hasWallpaperStillGpu(): boolean {
  return gpu() !== null;
}

/**
 * Draws one small frame of a module that links, at its defaults and without
 * an image, and waits for the GPU to finish it: a shader that hangs the GPU
 * does so here, inside the module's check, not first on the wallpaper.
 */
export function probeWallpaperStillDraw(module: WallpaperModule): void {
  const context = gpu();
  if (!context) return;
  const result = linked(context, module);
  if (!result.ok) return;
  const { canvas, gl, resources } = context;
  canvas.width = PROBE_SIZE;
  canvas.height = PROBE_SIZE;
  const uniforms = wallpaperParamUniforms(module.manifest, resolveWallpaperValues(module.manifest, {}, "light"));
  revision += 1;
  const drawn = { compiled: result.base, overlay: result.overlay, module, uniforms, dark: false, image: null, revision };
  drawWallpaperScene(gl, resources, drawn, { width: PROBE_SIZE, height: PROBE_SIZE, ...STILL_FRAME, timeMs: 0 });
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
}

/** Uploads a scene's default image once (decoded small); stills keep it. */
async function ensureImage(image: WallpaperImageScene): Promise<void> {
  if (gpu()?.resources.images.get(image.asset)) return;
  const blob = await loadWallpaperImageBytes(NO_LOADER, image.asset, "thumbnail");
  const bitmap = await createImageBitmap(blob, {
    imageOrientation: "flipY",
    premultiplyAlpha: "premultiply",
    resizeWidth: STILL_IMAGE_EDGE,
    resizeQuality: "high",
  });
  gpu()?.resources.images.upload(image.asset, "thumbnail", bitmap);
  bitmap.close();
}

/**
 * Draws a scene once, composed at screen size and scaled down to `size`, on
 * the shared context and encodes it (the bitmap is copied synchronously). Module default images load first; a
 * two-pass module draws its base and overlay at its still clock.
 */
export async function drawWallpaperStill(scene: WallpaperScene, size: { width: number; height: number }): Promise<Blob> {
  if (!gpu()) throw new Error("WebGL2 is unavailable");
  if (scene.image) await ensureImage(scene.image);
  const context = gpu();
  if (!context) throw new Error("WebGL2 is unavailable");
  const { canvas, gl, resources } = context;
  const screen = { width: Math.max(size.width, STILL_SCREEN_WIDTH), height: Math.max(size.height, Math.round((STILL_SCREEN_WIDTH * size.height) / size.width)) };
  canvas.width = screen.width;
  canvas.height = screen.height;
  const result = linked(context, scene.module);
  if (!result.ok) throw new Error(result.log);
  const uniforms = wallpaperParamUniforms(scene.module.manifest, scene.values);
  revision += 1;
  const drawn = { compiled: result.base, overlay: result.overlay, module: scene.module, uniforms, dark: scene.dark, image: scene.image, revision };
  drawWallpaperScene(gl, resources, drawn, { ...screen, ...STILL_FRAME, timeMs: (scene.module.stillTime ?? 0) * 1000 });
  return encodeScaled(canvas, size);
}
