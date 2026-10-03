import { SHORELINE_WALLPAPER } from "../../blocks/Wallpaper/modules";
import { liveWallpaperScene } from "../../blocks/Wallpaper/registry";
import { createWallpaperRenderer } from "../../blocks/Wallpaper/renderer";

/** The existing shoreline shader, at device resolution. No wallpaper idle scheduler. */
export function coastalScene(canvas: HTMLCanvasElement) {
  const renderer = createWallpaperRenderer(canvas, { onError: () => { canvas.dataset.error = "true"; } });
  if (!renderer) { canvas.dataset.error = "true"; return null; }
  renderer.setScene(liveWallpaperScene(SHORELINE_WALLPAPER,
    { kind: "live", module: "butler.shoreline", params: { realtime: false } }, "light"));
  let width = 1;
  let height = 1;
  let time = 8000;
  let pixelRatio = window.devicePixelRatio || 1;
  const draw = (delta = 0) => {
    time += delta;
    renderer.draw({ width, height, pixelRatio, timeMs: time, dayPhase: 0.5, seed: 0.42 });
  };
  const resize = new ResizeObserver(() => {
    pixelRatio = window.devicePixelRatio || 1;
    width = Math.max(1, Math.round(canvas.clientWidth * pixelRatio));
    height = Math.max(1, Math.round(canvas.clientHeight * pixelRatio));
    draw();
    canvas.dataset.ready = "true";
  });
  resize.observe(canvas);
  const lost = (event: Event) => { event.preventDefault(); canvas.dataset.error = "true"; };
  const restored = () => { renderer.restore(); draw(); delete canvas.dataset.error; };
  canvas.addEventListener("webglcontextlost", lost);
  canvas.addEventListener("webglcontextrestored", restored);
  return { draw, dispose() {
    resize.disconnect();
    canvas.removeEventListener("webglcontextlost", lost);
    canvas.removeEventListener("webglcontextrestored", restored);
    renderer.dispose();
  } };
}
