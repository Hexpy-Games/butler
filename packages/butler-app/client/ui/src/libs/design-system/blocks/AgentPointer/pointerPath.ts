/**
 * Geometry of Butler's pointer travel: every move is a cubic Bézier, so the glide, the dotted trail and the
 * batch path are the same curve. Pure functions in layer pixels; no DOM.
 */
export interface PathPoint { x: number; y: number }
export interface PathRect { x: number; y: number; width: number; height: number }
/** One cubic segment: start, two controls, end. */
export type Cubic = [PathPoint, PathPoint, PathPoint, PathPoint];

const add = (a: PathPoint, b: PathPoint, k = 1): PathPoint => ({ x: a.x + b.x * k, y: a.y + b.y * k });
const sub = (a: PathPoint, b: PathPoint): PathPoint => ({ x: a.x - b.x, y: a.y - b.y });
const length = (v: PathPoint) => Math.hypot(v.x, v.y);

export const samePoint = (a: PathPoint, b: PathPoint, tolerance = 0.5) => Math.abs(a.x - b.x) <= tolerance && Math.abs(a.y - b.y) <= tolerance;

/** The bow: a gentle arc to one side of the chord, 14% of the travel, at most 64px (the curve peaks at 3/4 of it). */
function bow(chord: PathPoint): PathPoint {
  const travel = length(chord);
  if (travel < 1) return { x: 0, y: 0 };
  // The side whose normal points up (a hand's arc); straight-down travel bows left.
  let normal = { x: -chord.y / travel, y: chord.x / travel };
  if (normal.y > 1e-6 || (Math.abs(normal.y) <= 1e-6 && normal.x > 0)) normal = { x: -normal.x, y: -normal.y };
  return add({ x: 0, y: 0 }, normal, Math.min(travel * 0.14, 64));
}

/**
 * A glide from `from` to `to`. With `heading` (the direction the pointer moves in right now, after an
 * interruption) the curve leaves along it, so the turn is smooth; otherwise it starts along the bow.
 */
export function glideCurve(from: PathPoint, to: PathPoint, heading?: PathPoint): Cubic {
  const chord = sub(to, from);
  const travel = length(chord);
  const offset = bow(chord);
  const ahead = heading && length(heading) > 1e-6 ? add(from, heading, Math.min(travel * 0.35, 120) / length(heading)) : add(add(from, chord, 0.3), offset);
  return [from, ahead, add(add(from, chord, 0.7), offset), to];
}

/**
 * A smooth path through batch stops: Catmull-Rom tangents inside, the glide's bow at both ends, so two
 * stops give exactly `glideCurve(a, b)` and every stop is passed through.
 */
export function throughCurve(points: PathPoint[]): Cubic[] {
  if (points.length < 2) return [];
  const last = points.length - 1;
  const tangent = (index: number): PathPoint => {
    if (index === 0) return sub(glideCurve(points[0]!, points[1]!)[1], points[0]!);
    if (index === last) return sub(points[last]!, glideCurve(points[last - 1]!, points[last]!)[2]);
    // Catmull-Rom: half the span between neighbours, as a cubic control a third along.
    return { x: (points[index + 1]!.x - points[index - 1]!.x) / 6, y: (points[index + 1]!.y - points[index - 1]!.y) / 6 };
  };
  return points.slice(0, last).map((start, index) => {
    const end = points[index + 1]!;
    return [start, add(start, tangent(index)), sub(end, tangent(index + 1)), end];
  });
}

export function pointOn([p0, p1, p2, p3]: Cubic, s: number): PathPoint {
  const r = 1 - s;
  const a = r * r * r, b = 3 * r * r * s, c = 3 * r * s * s, d = s * s * s;
  return { x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y };
}

/** SVG path data for consecutive cubic segments. */
export function pathData(segments: Cubic[]): string {
  if (!segments.length) return "";
  const n = (value: number) => Math.round(value * 100) / 100;
  const pt = (p: PathPoint) => `${n(p.x)},${n(p.y)}`;
  return `M${pt(segments[0]![0])}${segments.map(([, c1, c2, end]) => ` C${pt(c1)} ${pt(c2)} ${pt(end)}`).join("")}`;
}

/**
 * Positions along `curve` at `count + 1` evenly spaced times, eased by `ease`: the keyframes of one glide.
 * Played back with linear timing, the pointer moves along the curve with the token easing.
 */
export function glideSamples(curve: Cubic, ease: (t: number) => number, count = 32): PathPoint[] {
  return Array.from({ length: count + 1 }, (_, index) => pointOn(curve, ease(index / count)));
}

/** The position (and heading) a sampled glide has at time fraction `t`, as linear keyframes play it. */
export function sampleAt(samples: PathPoint[], t: number): { at: PathPoint; heading: PathPoint } {
  const span = samples.length - 1;
  const clamped = Math.min(1, Math.max(0, t)) * span;
  const index = Math.min(span - 1, Math.floor(clamped));
  const a = samples[index]!, b = samples[index + 1]!;
  return { at: add(a, sub(b, a), clamped - index), heading: sub(b, a) };
}

/**
 * True when a target is the whole page: it spans the layer edge to edge on one axis and covers at least
 * 80% of the other (a letterboxed page). Such a target gets no ring: the PageCard edge already outlines it.
 */
export function coversLayer(rect: PathRect, width: number, height: number): boolean {
  const slack = 4;
  const spansX = rect.x <= slack && rect.x + rect.width >= width - slack;
  const spansY = rect.y <= slack && rect.y + rect.height >= height - slack;
  return (spansX && rect.height >= height * 0.8) || (spansY && rect.width >= width * 0.8);
}

/** Intersection over union of two rects: near 1 means the same element re-measured. */
export function overlap(a: PathRect, b: PathRect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  const inter = Math.max(0, w) * Math.max(0, h);
  const union = a.width * a.height + b.width * b.height - inter;
  return union > 0 ? inter / union : 0;
}
