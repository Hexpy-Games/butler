// WebGL context attributes of wallpaper canvases, opaque (the default) and transparent.
import type { WallpaperDrawFrame } from "./glDraw";

/**
 * Never `desynchronized`: the low-latency mode exists only on Windows and ChromeOS (Chromium presents such a canvas
 * through its own D3D11 swap chain, a DirectComposition overlay), so the drawing buffer the drift layers and the
 * crossfade copy from would follow other rules there than on macOS and Linux. A wallpaper gains nothing from low
 * latency. No `preserveDrawingBuffer` either (no extra buffer copy per presented frame): every copy out of this canvas
 * (driftLayers.present, the crossfade snapshot) runs in the same task right after the draw, while the drawing buffer
 * is defined on every platform.
 */
const CONTEXT_ATTRIBUTES: WebGLContextAttributes = {
  alpha: false,
  antialias: false,
  depth: false,
  stencil: false,
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

/** Context attributes of a wallpaper canvas, opaque or transparent. */
export function wallpaperContextAttributes(transparent: boolean): WebGLContextAttributes {
  return transparent ? TRANSPARENT_CONTEXT_ATTRIBUTES : CONTEXT_ATTRIBUTES;
}

/** Starts a transparent frame from nothing, so whatever the module leaves at alpha 0 shows what is behind. */
export function clearTransparent(gl: WebGL2RenderingContext, frame: WallpaperDrawFrame) {
  gl.viewport(0, 0, frame.width, frame.height);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
}
