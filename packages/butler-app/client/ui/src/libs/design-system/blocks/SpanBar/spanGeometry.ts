/** Fractions (0–1) of the trace a span covers, clamped to the trace. */
export interface SpanFraction {
  start: number;
  width: number;
}

/**
 * Clamps a span to [0, total]; a zero, negative or non-finite total yields an
 * empty span, and a non-finite offset or duration counts as 0.
 */
export function spanFraction(offset: number, duration: number, total: number): SpanFraction {
  if (!validTotal(total)) return { start: 0, width: 0 };
  const from = finiteOr0(offset);
  const start = clamp(from, 0, total);
  const end = clamp(from + Math.max(0, finiteOr0(duration)), start, total);
  return { start: start / total, width: (end - start) / total };
}

/** A direct child of a span, in the same unit as the span (ms from the trace start). */
export interface SpanSegmentInput<T> {
  offset: number;
  duration: number;
  tone: T;
}

/** One painted piece of a span, as fractions (0–1) of the span itself. */
export interface SpanPiece<T> {
  start: number;
  width: number;
  tone: T;
  /** Every other drawn child is hatched, so adjacent children stay apart without gaps. */
  hatch: boolean;
}

/**
 * Splits a span into one piece per direct child (time order, clipped to the
 * span, overlaps cut at the earlier child's end) and fills the span's
 * uncovered time with pieces in its own tone. Returns no pieces when the
 * span is empty or no child lands inside it: the caller draws a plain bar.
 */
export function spanPieces<T>(offset: number, duration: number, tone: T, segments: readonly SpanSegmentInput<T>[]): SpanPiece<T>[] {
  const from = finiteOr0(offset);
  const end = from + (Number.isFinite(duration) ? Math.max(0, duration) : 0);
  if (end <= from) return [];
  const length = end - from;
  const piece = (start: number, stop: number, pieceTone: T, hatch: boolean): SpanPiece<T> =>
    ({ start: (start - from) / length, width: (stop - start) / length, tone: pieceTone, hatch });
  const children = segments
    .filter((segment) => Number.isFinite(segment.offset) && Number.isFinite(segment.duration) && segment.duration > 0)
    .sort((left, right) => left.offset - right.offset);
  const pieces: SpanPiece<T>[] = [];
  let cursor = from;
  let drawn = 0;
  for (const child of children) {
    const start = Math.max(child.offset, cursor);
    const stop = Math.min(child.offset + child.duration, end);
    if (stop <= start) continue;
    if (start > cursor) pieces.push(piece(cursor, start, tone, false));
    pieces.push(piece(start, stop, child.tone, drawn % 2 === 1));
    drawn += 1;
    cursor = stop;
  }
  if (drawn === 0) return [];
  if (end > cursor) pieces.push(piece(cursor, end, tone, false));
  return pieces;
}

/** The smallest 1·2·5 × 10ⁿ step that splits `total` into at most `intervals` parts. */
export function spanTickStep(total: number, intervals = 4): number {
  if (!validTotal(total)) return 0;
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
  if (!validTotal(total)) return [0];
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

/** Nesting depth as a whole level ≥ 0 (non-finite counts as 0). */
export function spanLevel(depth: number): number {
  return Number.isFinite(depth) ? Math.max(0, Math.floor(depth)) : 0;
}

function validTotal(total: number): boolean {
  return Number.isFinite(total) && total > 0;
}

function finiteOr0(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
