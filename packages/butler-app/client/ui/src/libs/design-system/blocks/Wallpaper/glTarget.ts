/** A drawing-buffer-sized texture that is drawn into only when its inputs change. */
export interface WallpaperRenderTarget {
  /**
   * The target's texture. `render` draws into it (its framebuffer bound, the
   * default one restored after) only when the size or `key` changed.
   */
  use(width: number, height: number, key: string, render: () => void): WebGLTexture | null;
  dispose(): void;
}

/** One cached render target (RGBA8, edge-clamped) sampled with `filter` (LINEAR or NEAREST). */
export function createWallpaperRenderTarget(gl: WebGL2RenderingContext, filter: number): WallpaperRenderTarget {
  let target: { framebuffer: WebGLFramebuffer | null; texture: WebGLTexture | null; width: number; height: number; key: string | null } | null = null;

  const release = () => {
    if (!target) return;
    gl.deleteFramebuffer(target.framebuffer);
    gl.deleteTexture(target.texture);
    target = null;
  };

  return {
    use(width, height, key, render) {
      if (!target || target.width !== width || target.height !== height) {
        release();
        const texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        target = { framebuffer: gl.createFramebuffer(), texture, width, height, key: null };
      }
      if (target.key !== key) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target.texture, 0);
        render();
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        target.key = key;
      }
      return target.texture;
    },
    dispose: release,
  };
}
