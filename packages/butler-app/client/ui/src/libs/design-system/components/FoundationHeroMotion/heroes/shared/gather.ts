import type { Box, Key } from "../../heroTimeline";
import { TRANSITION } from "./beats";

/** Canvas px an item starts beyond the frame's edge. */
const BEYOND = 60;
/** Beats between one item's flight and the next. */
const STAGGER = 0.35;

export interface Flight {
  /** Where it starts, as an offset from its slot (canvas px). */
  from: { x: number; y: number };
  start: number;
  end: number;
}

const union = (boxes: Box[]): Box => {
  const x = Math.min(...boxes.map((box) => box.x));
  const y = Math.min(...boxes.map((box) => box.y));
  return { x, y, w: Math.max(...boxes.map((box) => box.x + box.w)) - x, h: Math.max(...boxes.map((box) => box.y + box.h)) - y };
};

/**
 * The finale's gather on the wide canvas: every item flies in straight from
 * the frame's edge nearest its slot (top-row items from the top, left-column
 * items from the left…), so the poster converges from all sides. Items
 * further inside go first, so no flight passes through a slot already filled,
 * and flights from one edge run parallel: no two paths cross. The last
 * component, built in place, is already home.
 */
export function gatherFlights(slots: Record<string, Box>, last: string | null, finale: number): Record<string, Flight> {
  const frame = union(Object.values(slots));
  const edges = Object.keys(slots).filter((id) => id !== last).map((id) => {
    const s = slots[id]!;
    const reach = { l: s.x - frame.x, r: frame.x + frame.w - (s.x + s.w), t: s.y - frame.y, b: frame.y + frame.h - (s.y + s.h) };
    const side = (Object.keys(reach) as Array<keyof typeof reach>).reduce((best, key) => (reach[key] < reach[best] ? key : best), "l");
    const from = side === "l" ? { x: -(reach.l + s.w + BEYOND), y: 0 } : side === "r" ? { x: reach.r + s.w + BEYOND, y: 0 }
      : side === "t" ? { x: 0, y: -(reach.t + s.h + BEYOND) } : { x: 0, y: reach.b + s.h + BEYOND };
    return { id, depth: reach[side], from };
  }).sort((a, b) => b.depth - a.depth);
  const flights: Record<string, Flight> = last ? { [last]: { from: { x: 0, y: 0 }, start: finale, end: finale + 0.4 } } : {};
  edges.forEach(({ id, from }, n) => {
    const start = finale + 0.2 + n * STAGGER;
    flights[id] = { from, start, end: start + TRANSITION * 0.8 };
  });
  return flights;
}

/** An item's keys around the gather: held where it was until the finale, then (off-camera) set beyond its edge and flown home. */
export function gatherKeys(flight: Flight, before: { x: number; y: number }, finale: number, pz: number): Key[] {
  const from = { x: flight.from.x / pz, y: flight.from.y / pz };
  return [
    { at: finale - 0.01, ...before }, { at: finale, ...from }, { at: flight.start, ...from },
    { at: flight.end, x: 0, y: 0, ease: "decelerate" },
  ];
}
