import {
  CONFIG,
  CENTER,
  PEAK_POSITIONS,
  PEAK_HEIGHTS,
  PEAK_DURATIONS,
  PEAK_CYCLE_MS,
  WAVE_LAYERS,
  type WaveLayer,
  type Side,
  type Point,
} from "./constants";
import { clamp, smootherstep, bowtieDistance } from "./math-utils";

export function activeWave(u: number, t: number, layer: WaveLayer) {
  const layerTime = t + layer.timeShift;
  const time = t * 0.001;
  let elapsed = layerTime % PEAK_CYCLE_MS;
  let index = 0;

  while (elapsed >= (PEAK_DURATIONS[index] ?? PEAK_DURATIONS[0])) {
    elapsed -= PEAK_DURATIONS[index] ?? PEAK_DURATIONS[0];
    index = (index + 1) % PEAK_DURATIONS.length;
  }

  const duration = PEAK_DURATIONS[index] ?? PEAK_DURATIONS[0];
  const local = smootherstep(elapsed / duration);
  const current = (index + layer.peakShift) % PEAK_POSITIONS.length;
  const next = (index + 1 + layer.peakShift) % PEAK_POSITIONS.length;
  const clampedPeak =
    (PEAK_POSITIONS[current] ?? 0.5) * (1 - local) +
    (PEAK_POSITIONS[next] ?? 0.5) * local +
    layer.xShift;
  const height = (PEAK_HEIGHTS[current] ?? 1) * (1 - local) + (PEAK_HEIGHTS[next] ?? 1) * local;
  const width = 0.24 + Math.sin(time * 2.6 + current) * 0.025;
  const flicker =
    0.9 +
    Math.sin(time * 5.8 + current * 0.7) * 0.08 +
    Math.sin(time * 8.2 + next) * 0.04;
  const gain = height * flicker;
  const dx = (u - clampedPeak) / width;
  const primary = Math.exp(-0.5 * dx * dx);
  const shoulderLeft = Math.exp(-0.5 * Math.pow((u - clampedPeak + width * 0.52) / (width * 1.55), 2));
  const shoulderRight = Math.exp(-0.5 * Math.pow((u - clampedPeak - width * 0.52) / (width * 1.55), 2));
  const envelope = gain * (primary * 0.72 + (shoulderLeft + shoulderRight) * 0.14);
  const edgeGate = smootherstep(clamp(u / 0.08, 0, 1)) * smootherstep(clamp((1 - u) / 0.08, 0, 1));
  return 168 * layer.yScale * clamp(envelope * edgeGate, 0, 1.12);
}

export function graphExtent(morph: number) {
  return CONFIG.graphRadius + smootherstep(morph) * (CONFIG.activeRadius - CONFIG.graphRadius);
}

export function xAt(u: number, morph: number) {
  const extent = graphExtent(morph);
  return CENTER - extent + extent * 2 * u;
}

export function transitionParts(morph: number) {
  return {
    toLine: smootherstep(clamp(morph / 0.48, 0, 1)),
    toWave: smootherstep(clamp((morph - 0.52) / 0.48, 0, 1)),
  };
}

function bowtieDisplacement(u: number, side: Side) {
  return side === "top" ? -bowtieDistance(u) : bowtieDistance(u);
}

function activeDisplacement(u: number, side: Side, t: number, layer: WaveLayer) {
  const wave = activeWave(u, t, layer);
  return side === "top" ? -wave : wave;
}

export function graphPoint(u: number, side: Side, t: number, morph: number, layer: WaveLayer = WAVE_LAYERS[0]): Point {
  const parts = transitionParts(morph);
  const idle = bowtieDisplacement(u, side);
  const active = activeDisplacement(u, side, t, layer);
  const base = idle * (1 - parts.toLine);
  const displacement = base * (1 - parts.toWave) + active * parts.toWave;
  return [xAt(u, morph), CENTER + displacement];
}

export function collectPoints(side: Side, t: number, morph: number, layer: WaveLayer = WAVE_LAYERS[0]) {
  const points: Point[] = [];
  for (let i = 0; i <= CONFIG.samples; i += 1) {
    const u = i / CONFIG.samples;
    points.push(graphPoint(u, side, t, morph, layer));
  }
  return points;
}