import type { Key, Pose, Track } from "../../heroTimeline";
import { TRANSITION } from "../shared/beats";
import type { HeroLayout } from "../shared/grid";
import { introTracks } from "../shared/Intro";
import { reveal, revealBeats, select, STEP_CAP } from "../shared/Reveal";
import type { Marks } from "../shared/types";
import type { SceneContext, SceneGeometry } from "../scene/types";
import type { FocusCopy } from "./focusCopy";
import type { KeyId } from "./FocusScenes";

/**
 * 07 Focus ring, "the route", beat marks:
 *
 *   0–6.8     Title     one ring on "Focus", then on "ring"
 *   6.8–17.4  One ring  Tab ×4 along a short row; the ring takes each corner
 *   17.4–24.4 Close-up  two pixels, the accent colour, the control's corner
 *   24.4–     Route     the real app in reading order (wide: New chat,
 *                       Search, the view tabs as one stop with → ←, the open
 *                       conversation, Settings, then the composer: its caret,
 *                       typing, more, access, model, Send; tall: the sidebar
 *                       toggle, then the composer); Shift+Tab walks it back
 *   then      Tabs      one stop: Tab in, → → between tabs, Tab out
 */
const AT = { row: 6.8, presses: [11.4, 12.9, 14.4, 15.9], close: 17.4, route: 24.4 } as const;

/** How a stop shows focus, as the DS draws it: the ring (--focus-ring), the base outline (2px at 1px), a tab's fill, a text field's caret. */
type Kind = "ring" | "outline" | "fill" | "caret";
type Press = [at: number, key: KeyId, stop: string, kind: Kind];

/** The route per canvas: presses in beats from the route scene's arrival. */
const ROUTE: Record<HeroLayout, { presses: Press[]; typing: number; jump: [number, number]; tabs: [number, number]; end: number }> = {
  wide: {
    presses: [
      [0.6, "tab", "nav0", "ring"], [1.8, "tab", "nav1", "ring"], [3, "tab", "tab-all", "fill"], [4.2, "right", "tab-recent", "fill"], [5.4, "left", "tab-all", "fill"],
      [6.6, "tab", "chat", "ring"], [7.8, "tab", "set", "ring"], [9.2, "tab", "field", "caret"],
      [12.4, "tab", "plus", "ring"], [13.2, "tab", "perm", "ring"], [14, "tab", "model", "ring"], [14.8, "tab", "send", "outline"],
      [16.6, "back", "model", "ring"], [17.4, "back", "perm", "ring"], [18.2, "back", "plus", "ring"], [19, "back", "field", "caret"], [20.2, "back", "set", "ring"],
    ],
    typing: 10.4, jump: [9.2, 20.2], tabs: [4.2, 5.4], end: 22,
  },
  tall: {
    presses: [
      [0.6, "tab", "toggle", "ring"], [2.2, "tab", "field", "caret"],
      [5.4, "tab", "plus", "ring"], [6.2, "tab", "perm", "ring"], [7, "tab", "model", "ring"], [7.8, "tab", "send", "outline"],
      [9.6, "back", "model", "ring"], [10.4, "back", "perm", "ring"], [11.2, "back", "plus", "ring"], [12, "back", "field", "caret"], [13.2, "back", "toggle", "ring"],
    ],
    typing: 3.4, jump: [2.2, 13.2], tabs: [0, 0], end: 15,
  },
};

/** The Tabs scene, in beats from its arrival. */
const TABS: Press[] = [[0.6, "tab", "t0", "ring"], [1.8, "right", "t1", "ring"], [3, "right", "t2", "ring"], [4.2, "tab", "open", "ring"]];
const TABS_END = 6;

/** The route scene's arrival, and the Tabs scene's (after the route of that canvas). */
const ROUTE_AT = AT.route + TRANSITION;
const tabsStart = (layout: HeroLayout) => ROUTE_AT + ROUTE[layout].end + TRANSITION;

/** Beat the last scene (Tabs) ends. */
export function focusEnd(g: SceneGeometry): number {
  return tabsStart(g.layout) + TABS_END;
}

/** Keys that close the cycle: back to the first key's values. */
const looped = (keys: Key[], close: number): Key[] => {
  const { at: _at, ease: _ease, ...first } = keys[0]!;
  return [...keys, { at: close - 0.01 }, { at: close, ...first }];
};

/** The ring's pose on a mark: its box and corner, as the DS draws it (the outline stands 1px off the control). */
function on(marks: Marks, name: string, kind: Kind = "ring"): Pose {
  const m = marks[name];
  if (!m) return { x: 0, y: 0, w: 20, h: 20, rad: 8 };
  const off = kind === "outline" ? 1 : 0;
  return { x: m.box.x - off, y: m.box.y - off, w: m.box.w + off * 2, h: m.box.h + off * 2, rad: Math.min(m.r, m.box.h / 2) + off };
}

const shows = (kind: Kind) => kind === "ring" || kind === "outline";

/**
 * A ring walking stops: it slides between stops that draw a ring, fades out
 * where focus shows otherwise (a tab's fill, a field's caret) and fades back
 * in at the next ring.
 */
function walk(name: string, marks: Marks, presses: Press[], start: number, close: number): Track {
  const poses = presses.map(([, , stop, kind]) => on(marks, stop, kind));
  const keys: Key[] = [{ at: 0, ...poses[0]!, o: 0 }];
  presses.forEach(([at, , , kind], k) => {
    const t = start + at;
    const pose = poses[k]!;
    const was = k > 0 ? presses[k - 1]![3] : null;
    if (was === null || !shows(was)) {
      if (shows(kind)) keys.push({ at: t, ...pose, o: 0 }, { at: t + 0.3, o: 1 });
      return;
    }
    if (shows(kind)) keys.push({ at: t, ...poses[k - 1]!, o: 1 }, { at: t + 0.5, ...pose, o: 1, ease: "standard" });
    else keys.push({ at: t, o: 1 }, { at: t + 0.3, o: 0 });
  });
  return { select: select(name), keys: looped(keys, close) };
}

/** Key cap layers: each shows from its press until the next press, pressing in as it lands. */
function keyCaps(prefix: string, presses: Press[], start: number, ids: KeyId[], until: number, close: number): Track[] {
  return ids.map((id): Track => {
    const keys: Key[] = [{ at: 0, o: 0, s: 1 }];
    presses.forEach(([at, key], k) => {
      if (key !== id) return;
      const next = k + 1 < presses.length ? start + presses[k + 1]![0] : until;
      keys.push({ at: start + at - 0.01, o: 0, s: 1 }, { at: start + at, o: 1, s: 0.9 }, { at: start + at + 0.3, s: 1, ease: "standard" }, { at: next - 0.01, o: 1 }, { at: next, o: 0 });
    });
    return { select: select(`${prefix}-${id}`), keys: looped(keys, close) };
  });
}

/** A layer cut on and off at beats (no fade: a state changes at once). */
function cuts(name: string, first: 0 | 1, at: number[], close: number): Track {
  const keys: Key[] = [{ at: 0, o: first }];
  at.forEach((t, k) => {
    const o = (k % 2 === 0 ? 1 - first : first);
    keys.push({ at: t - 0.01, o: 1 - o }, { at: t, o });
  });
  return { select: select(name), keys: looped(keys, close) };
}

export function focusTracks(copy: FocusCopy) {
  return ({ g, close, view }: SceneContext): { tracks: Track[]; camera: Key[] } => {
    const { layout, canvas } = g;
    const route = ROUTE[layout];
    const r0 = ROUTE_AT;
    const t0 = tabsStart(layout);
    const end = focusEnd(g);
    const routeBox = g.boxes[`route-${layout}`] ?? g.boxes["route-wide"]!;
    const zoomAt = (cell: string, zoom: number): Pose => view(cell, { x: 0, y: 0, w: canvas.w / zoom, h: canvas.h / zoom }, 1, 99);
    const poses = [
      view("intro", g.boxes.intro!, 1, 1), view("row", g.boxes.row!, 0.85, 2.2), zoomAt("closeup", layout === "tall" ? 1.5 : 3),
      view("route", routeBox, 0.96, 1.6), view("tabs", g.boxes.tabs!, layout === "tall" ? 0.9 : 0.7, 2.4),
    ];
    const starts = [0, AT.row, AT.close, AT.route, t0 - TRANSITION];
    const camera: Key[] = [{ at: 0, ...poses[0]! }, ...starts.slice(1).flatMap((at, k): Key[] => [{ at, ...poses[k]! }, { at: at + TRANSITION, ...poses[k + 1]!, ease: "standard" }]), { at: end, ...poses[4]! }];
    const title = g.scopes.title ?? {};
    const row = g.scopes.row ?? {};
    const marks = g.scopes[`route-${layout}`] ?? {};
    const tabs = g.scopes.tabs ?? {};
    const shown = (name: string, from: number): Track => ({ select: select(name), keys: looped([{ at: 0, o: 0 }, { at: from, o: 0 }, { at: from + 0.5, o: 1 }], close) });
    const drawn = (name: string, at: number, back: number): Track => ({
      select: select(name), keys: looped([{ at: 0, dash: 100 }, { at, dash: 100 }, { at: at + 0.9, dash: 0, ease: "standard" }, { at: back, dash: 0 }, { at: back + 0.8, dash: 100, ease: "accelerate" }], close),
    });
    // The caret: on while the field has focus, stepping along the draft as it types.
    const typing = r0 + route.typing;
    const typedW = marks.typed?.box.w ?? 0;
    const steps = Math.max(1, Math.min(STEP_CAP, [...copy.typed].length));
    const step = revealBeats(steps) / steps;
    const focusedField = route.presses.flatMap(([at, , stop], k) => (stop === "field" ? [[r0 + at, r0 + (route.presses[k + 1]?.[0] ?? route.end)]] : []));
    const caretKeys: Key[] = [{ at: 0, x: 0, o: 0 }];
    for (const [from, to] of focusedField) caretKeys.push({ at: from - 0.01, o: 0 }, { at: from, o: 1 }, { at: to - 0.01, o: 1 }, { at: to, o: 0 });
    for (let k = 1; k <= steps; k += 1) caretKeys.push({ at: typing + k * step - 0.01, x: typedW * ((k - 1) / steps) }, { at: typing + k * step, x: typedW * (k / steps) });
    caretKeys.sort((a, b) => a.at - b.at);
    const tracks: Track[] = [
      ...introTracks(copy.title, copy.lead, close),
      ...reveal("i-t0", 0.4, copy.title, close), ...reveal("i-t1", 0.9, copy.title2, close),
      walk("tr", title, [[1.8, "tab", "w0", "ring"], [3.8, "tab", "w1", "ring"]], 0, close),
      walk("rr", row, AT.presses.map((at, k): Press => [at, "tab", `c${k}`, "ring"]), 0, close),
      ...keyCaps("rk", AT.presses.map((at): Press => [at, "tab", "", "ring"]), 0, ["tab"], AT.close, close),
      shown("cn-w", AT.close + TRANSITION + 0.4), ...reveal("cn-w-t", AT.close + TRANSITION + 0.4, "--focus-ring-width 2", close),
      shown("cn-c", AT.close + TRANSITION + 1.2), ...reveal("cn-c-t", AT.close + TRANSITION + 1.2, "--focus-ring-color", close),
      ...reveal("cap-0", r0 - 0.6, `① ${copy.regions[0]}`, close), ...reveal("cap-1", r0 - 0.2, `② ${copy.regions[1]}`, close), ...reveal("cap-2", r0 + 0.2, `③ ${copy.regions[2]}`, close),
      walk("sr", marks, route.presses, r0, close),
      ...keyCaps("sk", route.presses, r0, ["tab", "right", "left", "back"], t0 - TRANSITION, close),
      drawn("jump", r0 + route.jump[0], r0 + route.jump[1]),
      cuts("ph", 1, [typing], close), cuts("send-off", 1, [typing], close), cuts("send-on", 0, [typing], close),
      ...reveal("typed", typing, copy.typed, close),
      { select: select("caret"), keys: looped(caretKeys, close) },
      ...(route.tabs[0] ? [cuts("vt-all", 1, route.tabs.map((at) => r0 + at), close), cuts("vt-recent", 0, route.tabs.map((at) => r0 + at), close)] : []),
      walk("tr2", tabs, TABS, t0, close),
      ...keyCaps("tk", TABS, t0, ["tab", "right"], end, close),
      cuts("lt-0", 1, [t0 + TABS[1]![0]], close), cuts("lt-1", 0, [t0 + TABS[1]![0], t0 + TABS[2]![0]], close), cuts("lt-2", 0, [t0 + TABS[2]![0]], close),
      ...reveal("rv", t0 + TABS[1]![0] + 0.3, copy.roving, close),
    ];
    return { tracks, camera };
  };
}
