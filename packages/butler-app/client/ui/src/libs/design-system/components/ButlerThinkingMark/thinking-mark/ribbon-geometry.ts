import { AL, CENTER, RHO, RR, type SizeClass } from "./constants";
import { clamp } from "./motion";

/** The subset of the canvas path API the ribbon needs. */
export interface PathSink {
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  arc(x: number, y: number, radius: number, start: number, end: number, ccw?: boolean): void;
  closePath(): void;
}

/**
 * The ribbon is two opposing circular sectors (centre 600,600, R 329.43, half-angle ~24.4deg).
 * Fill it and stroke it with width 2 * RHO (round joins) to get the rounded logo shape.
 */
export function traceRibbon(sink: PathSink) {
  sink.beginPath();
  sink.moveTo(CENTER, CENTER);
  sink.lineTo(CENTER - 300, CENTER - 136);
  sink.arc(CENTER, CENTER, RR, Math.PI + AL, Math.PI - AL, true);
  sink.closePath();
  sink.moveTo(CENTER, CENTER);
  sink.lineTo(CENTER + 300, CENTER - 136);
  sink.arc(CENTER, CENTER, RR, -AL, AL, false);
  sink.closePath();
}

const SIN_AL = Math.sin(AL);
const COS_AL = Math.cos(AL);

/** Signed distance to a circular sector (Inigo Quilez sdPie), axis along +y. */
function sdPie(px: number, py: number, radius: number) {
  const ax = Math.abs(px);
  const l = Math.hypot(ax, py) - radius;
  const d = clamp(ax * SIN_AL + py * COS_AL, 0, radius);
  const m = Math.hypot(ax - SIN_AL * d, py - COS_AL * d);
  return Math.max(l, m * Math.sign(COS_AL * ax - SIN_AL * py));
}

/** Signed distance to the rounded ribbon: union of both lobes minus the rounding. */
export function sdRibbon(x: number, y: number) {
  const dx = x - CENTER;
  const dy = y - CENTER;
  return Math.min(sdPie(dy, -dx, RR), sdPie(dy, dx, RR)) - RHO;
}

export function sizeClass(cssSize: number): SizeClass {
  if (cssSize >= 64) return 2;
  if (cssSize >= 20) return 1;
  return 0;
}
