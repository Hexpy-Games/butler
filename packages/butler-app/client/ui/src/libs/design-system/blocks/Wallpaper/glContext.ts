// WebGL context attributes of wallpaper canvases, opaque (the default) and transparent.
import type { WallpaperDrawFrame } from "./glDraw";

const CONTEXT_ATTRIBUTES: WebGLContextAttributes = {
  alpha: false,
  antialias: false,
  depth: false,
  stencil: false,
  desynchronized: true,
  // No copy per frame: the crossfade repaints the frame right before it snapshots it.
  preserveDrawingBuffer: false,
  powerPreference: "low-power",
};

/**
 * A transparent canvas (modules with `transparent: true`): see-through where
 * the module draws nothing. Premultiplied like the page compositor, so the
 * module's premultiplied `fragColor` composites as is; every frame starts
 * cleared to 0.
 */
const TRANSPARENT_CONTEXT_ATTRIBUTES: WebGLContextAttributes = { ...CONTEXT_ATTRIBUTES, alpha: true, premultipliedAlpha: true };

/** Context attributes of a wallpaper canvas; opaque canvases keep the engine's original ones. */
export function wallpaperContextAttributes(transparent: boolean): WebGLContextAttributes {
  return transparent ? TRANSPARENT_CONTEXT_ATTRIBUTES : CONTEXT_ATTRIBUTES;
}

/** Starts a transparent frame from nothing, so whatever the module leaves at alpha 0 shows what is behind. */
export function clearTransparent(gl: WebGL2RenderingContext, frame: WallpaperDrawFrame) {
  gl.viewport(0, 0, frame.width, frame.height);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
}
