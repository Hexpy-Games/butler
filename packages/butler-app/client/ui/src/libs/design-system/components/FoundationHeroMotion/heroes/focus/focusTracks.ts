import type { Key, Pose, Track } from "../../heroTimeline";
import { TRANSITION } from "../shared/beats";
import { introTracks } from "../shared/Intro";
import { reveal, select } from "../shared/Reveal";
import type { Marks } from "../shared/types";
import type { SceneContext } from "../scene/types";
import type { FocusCopy } from "./focusCopy";

/**
 * 07 Focus ring, "the route", beat marks:
 *
 *   0–7.4     Title     a 2px ring draws around "Focus", then around "ring"
 *   6.8–17.4  One ring  Tab ×4 along a short row; the ring takes each corner
 *   17.4–24.4 Close-up  two pixels, the accent colour, the control's corner
 *   24.4–39   Route     through a real shell: Tab to the sidebar, ↓ ↓ inside
 *                       it, Tab to the composer (the list is skipped), typing,
 *                       Tab to Send; the route line accumulates
 *   39–45     Tabs      one stop: Tab in, → → between tabs, Tab out
 *   45–49.4   Back      Shift+Tab walks the route back as the line retracts
 */
const AT = { row: 6.8, presses: [11.4, 12.9, 14.4, 15.9], close: 17.4, route: 24.4, tabsIn: 39, tabsOut: 45, end: 49.4 } as const;
/** The route's key presses: [beat, key, stop] (stops name marks of the route scope). */
const ROUTE: Array<[number, "tab" | "down" | "right" | "back", string]> = [
  [29, "tab", "r0"], [30.6, "down", "r1"], [31.8, "down", "r2"], [33.4, "tab", "field"], [37, "tab", "send"],
  [40, "tab", "t0"], [41.2, "right", "t1"], [42.4, "right", "t2"], [43.6, "tab", "tp"],
  [46, "back", "field"], [47.2, "back", "r2"],
];

const looped = (keys: Key[], close: number): Key[] => {
  const { at: _at, ease: _ease, ...first } = keys[0]!;
  return [...keys, { at: close - 0.01 }, { at: close, ...first }];
};

/** The ring's pose on a mark: its box, sized (not scaled) and rounded to the control's own corner. */
function on(marks: Marks, name: string): Pose {
  const m = marks[name];
  if (!m) return { x: 0, y: 0, w: 20, h: 20, rad: 8 };
  return { x: m.box.x, y: m.box.y, w: m.box.w, h: m.box.h, rad: Math.min(m.r, m.box.h / 2) };
}

/** A ring walking stops: hidden until the first, moving to each at its beat. */
function walk(name: string, stops: Array<[number, Pose]>, close: number, hide: Array<[number, number]> = []): Track {
  const keys: Key[] = [{ at: 0, ...stops[0]![1], o: 0 }, { at: stops[0]![0] - 0.01, o: 0 }, { at: stops[0]![0] + 0.2, o: 1 }];
  stops.slice(1).forEach(([at, pose], k) => keys.push({ at, ...stops[k]![1] }, { at: at + 0.5, ...pose, ease: "standard" }));
  for (const [from, to] of hide) keys.push({ at: from, o: 1 }, { at: from + 0.3, o: 0 }, { at: to, o: 0 }, { at: to + 0.3, o: 1 });
  keys.sort((a, b) => a.at - b.at);
  return { select: select(name), keys: looped(keys, close) };
}

/** Key cap layers: each shows from its press until the next press, pressing in as it lands. */
function keyCaps(prefix: string, presses: Array<[number, string]>, ids: string[], close: number): Track[] {
  return ids.map((id): Track => {
    const keys: Key[] = [{ at: 0, o: 0, s: 1 }];
    presses.forEach(([at, key], k) => {
      if (key !== id) return;
      const next = presses[k + 1]?.[0] ?? at + 1.6;
      keys.push({ at: at - 0.01, o: 0, s: 1 }, { at, o: 1, s: 0.9 }, { at: at + 0.3, s: 1, ease: "standard" }, { at: next - 0.01, o: 1 }, { at: next, o: 0 });
    });
    return { select: select(`${prefix}-${id}`), keys: looped(keys, close) };
  });
}

const fade = (name: string, pairs: Array<[number, number]>, close: number, first = 0): Track => ({
  select: select(name), keys: looped([{ at: 0, o: first }, ...pairs.flatMap(([at, o]): Key[] => [{ at, o: 1 - o }, { at: at + 0.6, o, ease: "standard" }])], close),
});

export function focusTracks(copy: FocusCopy) {
  return ({ g, close, view }: SceneContext): { tracks: Track[]; camera: Key[] } => {
    const { layout, canvas } = g;
    const zoomAt = (cell: string, zoom: number): Pose => view(cell, { x: 0, y: 0, w: canvas.w / zoom, h: canvas.h / zoom }, 1, 99);
    const poses = [view("intro", g.boxes.intro!, 1, 1), view("row", g.boxes.row!, 0.85, 2.2), zoomAt("closeup", layout === "tall" ? 1.5 : 3), view("route", g.boxes.route!, 0.94, 1.6)];
    const starts = [0, AT.row, AT.close, AT.route];
    const camera: Key[] = [{ at: 0, ...poses[0]! }, ...starts.slice(1).flatMap((at, k): Key[] => [{ at, ...poses[k]! }, { at: at + TRANSITION, ...poses[k + 1]!, ease: "standard" }]), { at: AT.end, ...poses[3]! }];
    const row = g.scopes.row ?? {};
    const route = g.scopes.route ?? {};
    const shown = (name: string, from: number, to = close - 0.4): Track => ({ select: select(name), keys: [{ at: 0, o: 0 }, { at: from, o: 0 }, { at: from + 0.5, o: 1 }, { at: to, o: 1 }, { at: to + 0.4, o: 0 }] });
    const drawn = (name: string, at: number, back: number): Track => ({ select: select(name), keys: looped([{ at: 0, dash: 100 }, { at, dash: 100 }, { at: at + 0.9, dash: 0, ease: "standard" }, { at: back, dash: 0 }, { at: back + 0.8, dash: 100, ease: "accelerate" }], close) });
    const tab = (k: number): Pose => {
      const box = route[`t${k}`]?.box ?? { x: 0, y: 0, w: 40, h: 30 };
      return { x: box.x, y: box.y + box.h - 2, w: box.w, h: 2 };
    };
    const tracks: Track[] = [
      ...introTracks(copy.title, copy.lead, close),
      fade("tr-0", [[1.2, 1], [3.6, 0]], close), fade("tr-1", [[3.6, 1]], close),
      walk("rr", AT.presses.map((at, k) => [at, on(row, `c${k}`)]), close),
      ...keyCaps("rk", AT.presses.map((at) => [at, "tab"]), ["tab"], close),
      shown("cn-w", AT.close + TRANSITION + 0.4), shown("cn-c", AT.close + TRANSITION + 1),
      walk("sr", ROUTE.map(([at, , stop]) => [at, on(route, stop)]), close, [[AT.tabsIn - 0.4, AT.tabsIn + 0.6], [AT.tabsOut - 0.4, AT.tabsOut + 0.6]]),
      ...keyCaps("sk", ROUTE.map(([at, key]) => [at, key]), ["tab", "down", "right", "back"], close),
      drawn("seg-1", 33.4, 47.2), drawn("seg-2", 37, 46),
      fade("ph", [[34.6, 0]], close, 1), ...reveal("typed", 34.8, copy.typed, close),
      fade("shell", [[AT.tabsIn, 0], [AT.tabsOut, 1]], close, 1), fade("route-lines", [[AT.tabsIn, 0], [AT.tabsOut, 1]], close, 1),
      fade("tabs", [[AT.tabsIn, 1], [AT.tabsOut, 0]], close),
      { select: select("ti"), keys: looped([
        { at: 0, ...tab(0), o: 0 }, { at: AT.tabsIn, o: 0 }, { at: AT.tabsIn + 0.6, o: 1 }, { at: 41.2, ...tab(0) }, { at: 41.7, ...tab(1), ease: "standard" },
        { at: 42.4, ...tab(1) }, { at: 42.9, ...tab(2), ease: "standard" }, { at: AT.tabsOut, o: 1 }, { at: AT.tabsOut + 0.6, o: 0 },
      ], close) },
      shown("rv-t", 41.2, AT.tabsOut - 0.4),
    ];
    return { tracks, camera };
  };
}

export const FOCUS_END = AT.end;
