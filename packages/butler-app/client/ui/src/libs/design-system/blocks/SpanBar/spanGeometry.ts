/** Fractions (0–1) of the trace a span covers, clamped to the trace. */
export interface SpanFraction {
  start: number;
  width: number;
}

/** Clamps a span to [0, total]; a zero or negative total yields an empty span. */
export function spanFraction(offset: number, duration: number, total: number): SpanFraction {
  if (!(total > 0)) return { start: 0, width: 0 };
  const start = clamp(offset, 0, total);
  const end = clamp(offset + Math.max(0, duration), start, total);
  return { start: start / total, width: (end - start) / total };
}

/** The smallest 1·2·5 × 10ⁿ step that splits `total` into at most `intervals` parts. */
export function spanTickStep(total: number, intervals = 4): number {
  if (!(total > 0)) return 0;
  const raw = total / intervals;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((factor) => factor * magnitude).find((candidate) => candidate >= raw);
  return step ?? 10 * magnitude;
}

/**
 * Axis ticks: 0, the given (or 1·2·5) interior ticks, and the total. `gap`
 * is the least distance between two labels as a fraction of the axis; an
 * interior tick closer than that to its neighbour or to the total is
 * dropped, so labels never collide on a narrow axis.
 */
export function spanTicks(total: number, ticks?: readonly number[], gap = 0.12): number[] {
  if (!(total > 0)) return [0];
  const intervals = Math.max(1, Math.min(6, Math.floor(1 / gap)));
  const step = spanTickStep(total, intervals);
  const interior = ticks
    ? [...new Set(ticks)].filter((tick) => tick > 0 && tick < total).sort((a, b) => a - b)
    : Array.from({ length: Math.ceil(total / step) }, (_, index) => index * step).filter((tick) => tick > 0);
  const kept = [0];
  for (const tick of interior) {
    if ((tick - kept[kept.length - 1]!) / total >= gap && (total - tick) / total >= gap) kept.push(tick);
  }
  return [...kept, total];
}

/** Default label: milliseconds under a second, else seconds with up to two decimals. */
export function formatSpanMs(ms: number): string {
  if (ms === 0) return "0s";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${Number((ms / 1000).toFixed(2))}s`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
