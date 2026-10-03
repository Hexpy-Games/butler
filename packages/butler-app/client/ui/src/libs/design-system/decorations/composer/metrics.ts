import { EMPTY_METRICS, type DecorationMetrics } from "./types";

function percentile(samples: number[], fraction: number): number {
  return [...samples].sort((a, b) => a - b)[Math.max(0, Math.ceil(samples.length * fraction) - 1)] ?? 0;
}

/** Bounded samples; no draft text is observed or retained. GPU time is not CPU draw time. */
export function createDecorationMeter(canvas: HTMLCanvasElement, report: (metrics: DecorationMetrics) => void) {
  const draws: number[] = [];
  const inputs: number[] = [];
  let frames = 0;
  let edits = 0;
  let windowFrames = 0;
  let windowStart = performance.now();
  const sample = (values: number[], value: number) => {
    if (values.length === 128) values.shift();
    values.push(value);
  };
  return {
    input(ms: number) { edits += 1; sample(inputs, ms); },
    draw(ms: number) {
      frames += 1;
      sample(draws, ms);
      canvas.dataset.frames = String(frames);
    },
    report(state: DecorationMetrics["state"], force = false) {
      const now = performance.now();
      if (!force && now - windowStart < 1000) return;
      const metrics = {
        ...EMPTY_METRICS, frames, inputs: edits, state,
        fps: state === "live" ? (frames - windowFrames) * 1000 / (now - windowStart) : 0,
        drawP95: percentile(draws, 0.95), inputP99: percentile(inputs, 0.99),
      };
      canvas.dataset.inputP99 = String(metrics.inputP99);
      canvas.dataset.drawP95 = String(metrics.drawP95);
      canvas.dataset.inputs = String(edits);
      canvas.dataset.state = state;
      windowFrames = frames;
      windowStart = now;
      report(metrics);
    },
  };
}
