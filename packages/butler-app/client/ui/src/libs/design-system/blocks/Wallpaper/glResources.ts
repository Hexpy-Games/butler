import { createWallpaperImageGpu, type WallpaperImageGpu } from "./glImage";
import { createWallpaperProgramCache, type WallpaperProgramCache } from "./glProgram";
import { createWallpaperRenderTarget, type WallpaperRenderTarget } from "./glTarget";
import { WALLPAPER_NOISE_SIZE, wallpaperNoiseTexture } from "./noise";

/** GPU objects of one context; rebuilt as a whole after a context loss. */
export interface WallpaperGpuResources {
  programs: WallpaperProgramCache;
  noise: WebGLTexture | null;
  /** Neutral 1×1 `u_image` for scenes without an image. */
  image: WebGLTexture | null;
  /** Uploaded images, the filter pre-fit target and the dim pass. */
  images: WallpaperImageGpu;
  /** Cached `shader.frag` output of two-pass modules (their `u_base`). */
  base: WallpaperRenderTarget;
  vao: WebGLVertexArrayObject | null;
  precision: "highp" | "mediump";
}

function texture(gl: WebGL2RenderingContext, size: number, data: Uint8Array, wrap: number): WebGLTexture | null {
  const result = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, result);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  return result;
}

export function createWallpaperResources(gl: WebGL2RenderingContext): WallpaperGpuResources {
  const high = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
  const programs = createWallpaperProgramCache(gl);
  return {
    programs,
    noise: texture(gl, WALLPAPER_NOISE_SIZE, wallpaperNoiseTexture(), gl.REPEAT),
    image: texture(gl, 1, new Uint8Array([128, 128, 128, 255]), gl.CLAMP_TO_EDGE),
    images: createWallpaperImageGpu(gl, programs),
    base: createWallpaperRenderTarget(gl, gl.NEAREST),
    vao: gl.createVertexArray(),
    precision: high && high.precision > 0 ? "highp" : "mediump",
  };
}
