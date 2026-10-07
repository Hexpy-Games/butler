const markNames = new WeakMap<HTMLCanvasElement, string>();
let nextMark = 0;

/** Draw completion, independent of artwork. No reads, timers or persistence. */
export function resetWallpaperPaint(canvas: HTMLCanvasElement, state: string): void {
  const name = markNames.get(canvas);
  if (name) performance.clearMarks(name);
  canvas.dataset.wallpaperState = state;
  delete canvas.dataset.paintedModule;
  delete canvas.dataset.paintedTone;
}

export function signalWallpaperPaint(canvas: HTMLCanvasElement, module: string, tone: string): void {
  if (!canvas.width || !canvas.height || canvas.dataset.wallpaperState === "painted") return;
  canvas.dataset.paintedModule = module;
  canvas.dataset.paintedTone = tone;
  canvas.dataset.wallpaperState = "painted";
  // Keep one entry per canvas, including scene changes and context recovery.
  let name = markNames.get(canvas);
  if (!name) {
    name = `butler:wallpaper:first-frame:${++nextMark}`;
    markNames.set(canvas, name);
  }
  performance.clearMarks(name);
  performance.mark(name, { detail: { module, tone } });
}
