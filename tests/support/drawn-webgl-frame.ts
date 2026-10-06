export interface DrawnWebGLFrame {
  width: number;
  height: number;
  pixels: Uint8Array;
}

declare global {
  interface Window {
    butlerCaptureDrawnFrame(canvas: HTMLCanvasElement, budgetMs: number): Promise<DrawnWebGLFrame>;
  }
}

/** Read the actual screen draw before a non-preserved drawing buffer is cleared. */
export function installDrawnFrameCapture() {
  // Captures need live frames: opt out of the wallpaper engine's software-GL still-frame fallback
  // (headless CI). Init scripts run before <html> exists, so mark it once parsing starts (before app scripts run).
  const optOut = () => document.documentElement?.setAttribute("data-wallpaper-software-fallback", "off");
  if (document.documentElement) optOut();
  else document.addEventListener("readystatechange", optOut, { once: true });
  type Pending = { resolve: (frame: DrawnWebGLFrame) => void; timer: number; deadline: number };
  const waiting = new WeakMap<HTMLCanvasElement | OffscreenCanvas, Pending>();
  window.butlerCaptureDrawnFrame = (canvas, budgetMs) => new Promise((resolve, reject) => {
    if (waiting.has(canvas)) return reject(new Error("Overlapping frame capture"));
    const deadline = performance.now() + budgetMs;
    const timer = window.setTimeout(() => {
      waiting.delete(canvas);
      reject(new Error(`No WebGL screen draw within ${budgetMs}ms`));
    }, budgetMs);
    waiting.set(canvas, { resolve, timer, deadline });
  });
  for (const prototype of [WebGLRenderingContext.prototype, WebGL2RenderingContext.prototype]) {
    const draw = prototype.drawArrays;
    prototype.drawArrays = function(...args) {
      draw.apply(this, args);
      const pending = waiting.get(this.canvas);
      if (!pending || performance.now() >= pending.deadline || this.getParameter(this.FRAMEBUFFER_BINDING) !== null) return;
      waiting.delete(this.canvas);
      const width = this.drawingBufferWidth;
      const height = this.drawingBufferHeight;
      const pixels = new Uint8Array(width * height * 4);
      this.readPixels(0, 0, width, height, this.RGBA, this.UNSIGNED_BYTE, pixels);
      window.clearTimeout(pending.timer);
      pending.resolve({ width, height, pixels });
    };
  }
}
