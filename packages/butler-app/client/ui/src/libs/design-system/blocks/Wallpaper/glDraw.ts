import { NO_WALLPAPER_CONTENT_RECT, type WallpaperContentRectUniform } from "./contentRect";
import type { CompiledWallpaperProgram } from "./glProgram";
import type { WallpaperGpuResources } from "./glResources";
import type { WallpaperUniformValue } from "./glsl";
import type { WallpaperImageUniforms } from "./imageMath";
import { wallpaperShaderTime } from "./time";
import type { WallpaperModule } from "./types";

export interface WallpaperDrawFrame {
  width: number;
  height: number;
  pixelRatio: number;
  /** Animation clock (ms); wrapped into `u_time`. */
  timeMs: number;
  dayPhase: number;
  seed: number;
  /** `u_contentRect` in drawing-buffer px (bottom-left origin); zeros when omitted. */
  contentRect?: WallpaperContentRectUniform;
}

/** A linked module with its parameter uploads. */
export interface WallpaperDrawProgram {
  compiled: CompiledWallpaperProgram;
  module: WallpaperModule;
  uniforms: WallpaperUniformValue[];
  dark: boolean;
}

/** What one draw binds as `u_image`. */
export interface WallpaperImageInput {
  texture: WebGLTexture | null;
  /** `u_imageAspectRatio` (w/h); 0 without an image. */
  aspect: number;
  has: boolean;
  /** Fit and blur of the built-in image module (its engine-internal uniforms). */
  module?: WallpaperImageUniforms;
}

function upload(gl: WebGL2RenderingContext, location: WebGLUniformLocation | null, uniform: WallpaperUniformValue) {
  if (uniform.type === "float") gl.uniform1f(location, uniform.value);
  else if (uniform.type === "int") gl.uniform1i(location, uniform.value);
  else gl.uniform3fv(location, uniform.value);
}

/** Texture unit of `u_base` (a two-pass module's cached shader.frag output). */
const BASE_UNIT = 2;

/** One full-screen pass of a module into the bound framebuffer, with every engine uniform (and `u_base` for an overlay pass). */
export function drawWallpaperProgram(
  gl: WebGL2RenderingContext,
  resources: WallpaperGpuResources,
  { compiled, module, uniforms, dark }: WallpaperDrawProgram,
  frame: WallpaperDrawFrame,
  image: WallpaperImageInput,
  base?: WebGLTexture | null,
) {
  const uniform = compiled.uniform;
  gl.viewport(0, 0, frame.width, frame.height);
  gl.useProgram(compiled.program);
  gl.bindVertexArray(resources.vao);
  gl.uniform2f(uniform("u_resolution"), frame.width, frame.height);
  gl.uniform1f(uniform("u_pixelRatio"), frame.pixelRatio);
  gl.uniform1f(uniform("u_time"), wallpaperShaderTime(frame.timeMs, module.manifest.motion, module.manifest.timePeriod));
  gl.uniform1f(uniform("u_dark"), dark ? 1 : 0);
  gl.uniform1f(uniform("u_dayPhase"), frame.dayPhase);
  gl.uniform1f(uniform("u_seed"), frame.seed);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, resources.noise);
  gl.uniform1i(uniform("u_noiseTexture"), 0);
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, image.texture);
  gl.uniform1i(uniform("u_image"), 1);
  gl.uniform1f(uniform("u_hasImage"), image.has ? 1 : 0);
  gl.uniform1f(uniform("u_imageAspectRatio"), image.aspect);
  if (image.module) {
    gl.uniform4f(uniform("image_fit"), ...image.module.fit);
    gl.uniform3f(uniform("image_blur"), ...image.module.blur);
  }
  gl.uniform4f(uniform("u_contentRect"), ...(frame.contentRect ?? NO_WALLPAPER_CONTENT_RECT));
  if (base !== undefined) {
    gl.activeTexture(gl.TEXTURE0 + BASE_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, base);
    gl.uniform1i(uniform("u_base"), BASE_UNIT);
  }
  for (const value of uniforms) upload(gl, uniform(value.name), value);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}
