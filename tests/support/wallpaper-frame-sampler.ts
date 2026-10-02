/** Observe the actual draw before WebGL's non-preserved buffer is composited away. */
export function installWallpaperFrameSampler(): void {
  type Frame = { width: number; height: number; pixels?: Uint8Array | Uint8ClampedArray };
  const readers = new Map<HTMLCanvasElement, () => void>();
  const draw = WebGL2RenderingContext.prototype.drawArrays;
  WebGL2RenderingContext.prototype.drawArrays = function (...args) {
    draw.apply(this, args);
    const canvas = this.canvas;
    if (canvas instanceof HTMLCanvasElement && readers.has(canvas) && this.getParameter(this.FRAMEBUFFER_BINDING) === null) {
      readers.get(canvas)!();
    }
  };
  window.__readWallpaperFrame = async (canvas) => {
    const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    const width = gl?.drawingBufferWidth ?? canvas.width;
    const height = gl?.drawingBufferHeight ?? canvas.height;
    if (!gl) return { width, height, pixels: canvas.getContext("2d")?.getImageData(0, 0, width, height).data };
    return new Promise<Frame>((resolve) => {
      const capture = () => {
        clearTimeout(timer);
        readers.delete(canvas);
        const pixels = new Uint8Array(width * height * 4);
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        resolve({ width, height, pixels });
      };
      // A stopped renderer still fails the original pixel assertions; do not
      // alter its scheduling, preserve its buffer, or select samples by color.
      const timer = setTimeout(capture, 250);
      readers.set(canvas, capture);
    });
  };
}

declare global {
  interface Window {
    __readWallpaperFrame(canvas: HTMLCanvasElement): Promise<{
      width: number; height: number; pixels?: Uint8Array | Uint8ClampedArray;
    }>;
  }
}
