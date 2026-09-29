import type { WallpaperProgramCache } from "./glProgram";
import { createWallpaperRenderTarget } from "./glTarget";
import type { WallpaperImageVariant } from "./types";

export interface WallpaperImageTexture {
  texture: WebGLTexture | null;
  width: number;
  height: number;
  variant: WallpaperImageVariant;
  /** Bumped on every upload, so caches drawn from this texture know it changed. */
  generation: number;
}

/** Multiplies the frame's color by the source alpha (see `dim`). */
const DIM_FRAGMENT = [
  "#version 300 es",
  "precision mediump float;",
  "out vec4 fragColor;",
  "uniform float u_brightness;",
  "void main(){fragColor=vec4(0.,0.,0.,u_brightness);}",
].join("\n");

/** Image textures, the pre-fit target of filter modules and the dim pass of one context. */
export interface WallpaperImageGpu {
  /** Uploads a decoded image as a mipmapped, edge-clamped texture, replacing the asset's previous one. */
  upload(asset: string, variant: WallpaperImageVariant, bitmap: ImageBitmap): void;
  get(asset: string): WallpaperImageTexture | undefined;
  /** Deletes the textures of every asset not listed. */
  retain(assets: ReadonlySet<string>): void;
  /**
   * The drawing-buffer-sized texture filter modules read as `u_image`.
   * `render` draws into it only when `key` (image, fit, blur, tone, size) changed.
   */
  prefit(width: number, height: number, key: string, render: () => void): WebGLTexture | null;
  /** Multiplies the drawn frame by `brightness`; nothing at 1. */
  dim(brightness: number): void;
  dispose(): void;
}

function sampling(gl: WebGL2RenderingContext, minFilter: number) {
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, minFilter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
}

export function createWallpaperImageGpu(gl: WebGL2RenderingContext, programs: WallpaperProgramCache): WallpaperImageGpu {
  const textures = new Map<string, WallpaperImageTexture>();
  const target = createWallpaperRenderTarget(gl, gl.LINEAR);
  let generation = 0;

  return {
    upload(asset, variant, bitmap) {
      const result = textures.get(asset)?.texture ?? gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, result);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
      gl.generateMipmap(gl.TEXTURE_2D);
      sampling(gl, gl.LINEAR_MIPMAP_LINEAR);
      generation += 1;
      textures.set(asset, { texture: result, width: bitmap.width, height: bitmap.height, variant, generation });
    },
    get: (asset) => textures.get(asset),
    retain(assets) {
      for (const [asset, entry] of textures) {
        if (assets.has(asset)) continue;
        gl.deleteTexture(entry.texture);
        textures.delete(asset);
      }
    },
    prefit: (width, height, key, render) => target.use(width, height, key, render),
    dim(brightness) {
      if (brightness >= 1) return;
      const { result } = programs.get("wallpaper.dim", DIM_FRAGMENT);
      if (!result.ok) return;
      gl.useProgram(result.compiled.program);
      gl.uniform1f(result.compiled.uniform("u_brightness"), brightness);
      // rgb × source alpha; the destination alpha stays opaque.
      gl.enable(gl.BLEND);
      gl.blendFuncSeparate(gl.ZERO, gl.SRC_ALPHA, gl.ZERO, gl.ONE);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.disable(gl.BLEND);
    },
    dispose() {
      target.dispose();
      for (const entry of textures.values()) gl.deleteTexture(entry.texture);
      textures.clear();
    },
  };
}
