import { SHORELINE_WALLPAPER } from "../../blocks/Wallpaper/modules";
import { liveWallpaperScene } from "../../blocks/Wallpaper/registry";
import { createWallpaperRenderer } from "../../blocks/Wallpaper/renderer";
import { coastalGpuTimer } from "./coastalGpuTimer";

/** The existing shoreline shader. Cap raster density at 1x, independently of screen DPR. */
export function coastalScene(canvas: HTMLCanvasElement) {
  const renderer = createWallpaperRenderer(canvas, { onError: () => { canvas.dataset.error = "true"; } });
  if (!renderer) { canvas.dataset.error = "true"; return null; }
  const scene = liveWallpaperScene(SHORELINE_WALLPAPER,
    { kind: "live", module: "butler.shoreline", params: { realtime: false } }, "light");
  renderer.setScene(scene);
  const timer = coastalGpuTimer(canvas.getContext("webgl2")!);
  let width = 1;
  let height = 1;
  let time = 8000;
  let foam = 0.6;
  const draw = (delta = 0, pulse = 0) => {
    if (canvas.dataset.error) return timer.metrics;
    time += delta;
    const nextFoam = 0.6 + pulse * 0.25;
    if (foam !== nextFoam) {
      foam = nextFoam;
      renderer.setScene({ ...scene, values: { ...scene.values, foamAmount: foam } });
    }
    timer.begin();
    renderer.draw({ width, height, pixelRatio: 1, timeMs: time, dayPhase: 0.5, seed: 0.42 });
    timer.end();
    canvas.dataset.ready = "true";
    return timer.metrics;
  };
  const lost = (event: Event) => { event.preventDefault(); canvas.dataset.error = "true"; };
  // The runtime restarts only after restoration, including one static frame when paused.
  const restored = () => { timer.reset(); renderer.restore(); delete canvas.dataset.error; };
  canvas.addEventListener("webglcontextlost", lost);
  canvas.addEventListener("webglcontextrestored", restored);
  return { draw, resize(w: number, h: number) {
    width = Math.max(1, Math.round(w)); height = Math.max(1, Math.round(h));
  }, dispose() {
    canvas.removeEventListener("webglcontextlost", lost);
    canvas.removeEventListener("webglcontextrestored", restored);
    timer.dispose(); renderer.dispose();
  } };
}
export type CoastalScene = NonNullable<ReturnType<typeof coastalScene>>;
