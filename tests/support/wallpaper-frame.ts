/** Smoke-only readback: Wallpaper deliberately discards its drawing buffer after composition. */
declare global {
  interface Window {
    captureWallpaperPixels(canvas: HTMLCanvasElement): Promise<Uint8Array>;
  }
}

/** Install in the page so each sample reads a fresh, complete frame immediately after its draw. */
export function installWallpaperPixelCapture() {
  window.captureWallpaperPixels = (canvas) => {
    const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    if (!gl) return Promise.reject(new Error("Wallpaper has no WebGL context"));
    return new Promise<Uint8Array>((resolve, reject) => {
      const own = Object.getOwnPropertyDescriptor(gl, "drawArrays");
      const draw = gl.drawArrays;
      const restore = () => {
        clearTimeout(timer);
        if (own) Object.defineProperty(gl, "drawArrays", own);
        else Reflect.deleteProperty(gl, "drawArrays");
      };
      const timer = setTimeout(() => {
        restore();
        reject(new Error("Wallpaper did not draw a fresh frame"));
      }, 5_000);
      gl.drawArrays = function(mode, first, count) {
        draw.call(this, mode, first, count);
        const pixels = new Uint8Array(this.drawingBufferWidth * this.drawingBufferHeight * 4);
        this.readPixels(0, 0, this.drawingBufferWidth, this.drawingBufferHeight,
          this.RGBA, this.UNSIGNED_BYTE, pixels);
        restore();
        resolve(pixels);
      };
    });
  };
}
