// The shared offscreen WebGL2 contexts of stills and module checks: one opaque, one see-through for `transparent` modules.
import { createWallpaperResources, type WallpaperGpuResources } from "./glResources";
import type { WallpaperModule } from "./types";

export type StillCanvas = OffscreenCanvas | HTMLCanvasElement;

export interface StillGpu {
  canvas: StillCanvas;
  gl: WebGL2RenderingContext;
  resources: WallpaperGpuResources;
}

/** `transparent` modules draw on the see-through context (premultiplied, cleared to 0), created on first use. */
export type StillMode = "opaque" | "transparent";

const ATTRIBUTES: WebGLContextAttributes = {
  alpha: false,
  antialias: false,
  depth: false,
  stencil: false,
  preserveDrawingBuffer: true,
  powerPreference: "low-power",
};

const ATTRIBUTES_BY_MODE: Record<StillMode, WebGLContextAttributes> = {
  opaque: ATTRIBUTES,
  transparent: { ...ATTRIBUTES, alpha: true, premultipliedAlpha: true },
};

const shared: Record<StillMode, StillGpu | null> = { opaque: null, transparent: null };

export const stillModeOf = (module: WallpaperModule): StillMode => (module.manifest.transparent ? "transparent" : "opaque");

function createCanvas(): StillCanvas | null {
  if (typeof OffscreenCanvas === "function") return new OffscreenCanvas(1, 1);
  return typeof document === "undefined" ? null : document.createElement("canvas");
}

/** The mode's shared context, created on first use and again after a context loss. Wallpaper instances never dispose it. */
export function stillGpu(mode: StillMode = "opaque"): StillGpu | null {
  const current = shared[mode];
  if (current && !current.gl.isContextLost()) return current;
  const canvas = createCanvas();
  const gl = (canvas?.getContext("webgl2", ATTRIBUTES_BY_MODE[mode]) ?? null) as WebGL2RenderingContext | null;
  shared[mode] = canvas && gl ? { canvas, gl, resources: createWallpaperResources(gl) } : null;
  return shared[mode];
}

/** A transparent still starts from nothing (the drawing buffer is preserved between stills); opaque ones are untouched. */
export function clearTransparentStill({ gl }: StillGpu, mode: StillMode, size: { width: number; height: number }) {
  if (mode !== "transparent") return;
  gl.viewport(0, 0, size.width, size.height);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
}
