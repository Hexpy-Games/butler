// Diagnostic timestamps complement the unchanged qualification histogram.
import { monitorEventLoopDelay, performance } from "node:perf_hooks";

export function delayTimeline() {
  const histogram = monitorEventLoopDelay({ resolution: 1 });
  const outliers = [];
  let previous = performance.now(), previousWall = Date.now();
  histogram.enable();
  const timer = setInterval(() => {
    const now = performance.now(), wall = Date.now();
    const timerElapsedMs = now - previous;
    const maxMs = histogram.max / 1e6;
    if (maxMs > 100 || timerElapsedMs > 100) outliers.push({
      from: new Date(Math.min(previousWall, wall - maxMs)).toISOString(),
      to: new Date(wall).toISOString(), maxMs, timerElapsedMs,
      timestampPrecisionMs: 10,
    });
    previous = now; previousWall = wall; histogram.reset();
  }, 10);
  timer.unref();
  return {
    outliers,
    reset() { outliers.length = 0; previous = performance.now(); previousWall = Date.now(); histogram.reset(); },
    stop() { clearInterval(timer); histogram.disable(); },
  };
}
