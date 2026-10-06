// Software GL detection: without a GPU, every animated WebGL frame is read back on the main thread to composite.

/** Renderer strings of software rasterizers (SwiftShader, Mesa llvmpipe/softpipe/lavapipe, Windows' basic render driver). */
const SOFTWARE_RENDERER = /swiftshader|llvmpipe|softpipe|lavapipe|basic render driver|\bsoftware\b/iu;

/** The context's renderer string (unmasked when the browser allows it); "" when unknown. */
export function wallpaperRendererName(gl: WebGL2RenderingContext): string {
  const info = gl.getExtension("WEBGL_debug_renderer_info") as { UNMASKED_RENDERER_WEBGL: number } | null;
  const name: unknown = gl.getParameter(info?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER);
  return typeof name === "string" ? name : "";
}

/**
 * Test harnesses that must see live frames on software GL (CI, headless) opt
 * out of the still-frame fallback with `<html data-wallpaper-software-fallback="off">`.
 */
export function wallpaperSoftwareFallbackAllowed(): boolean {
  return typeof document === "undefined" || document.documentElement?.dataset?.wallpaperSoftwareFallback !== "off";
}

/** Whether a renderer string names a software rasterizer; an unknown renderer counts as hardware. */
export function isSoftwareWallpaperRenderer(name: string): boolean {
  return SOFTWARE_RENDERER.test(name);
}
