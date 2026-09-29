import type { Key, Pose, Track } from "../../heroTimeline";
import { TRANSITION } from "../shared/beats";
import type { HeroLayout } from "../shared/grid";
import { introTracks } from "../shared/Intro";
import { reveal, revealBeats, select, STEP_CAP } from "../shared/Reveal";
import type { Marks } from "../shared/types";
import type { SceneContext, SceneGeometry } from "../scene/types";
import type { FocusCopy } from "./focusCopy";
import { cuts, keyCaps, looped, walk, type Press } from "./focusWalk";

/**
 * 07 Focus ring, "the route", beat marks:
 *
 *   0–6.8     Title     one ring on "Focus", then on "ring"
 *   6.8–17.4  One ring  Tab ×4 along a short row; the ring takes each corner
 *   17.4–24.4 Close-up  two pixels, the accent colour, the control's corner
 *   24.4–     Route     the real app in reading order (wide: New chat,
 *                       Search, the open conversation, Settings, then the
 *                       composer: its caret, typing, more, access, model,
 *                       Send; tall: the sidebar toggle, then the composer);
 *                       Shift+Tab walks it back
 *   then      Group     the range picker is one stop: Tab in, → → inside, Tab out
 */
const AT = { row: 6.8, presses: [11.4, 12.9, 14.4, 15.9], close: 17.4, route: 24.4 } as const;

/** The route per canvas: presses in beats from the route scene's arrival. */
const ROUTE: Record<HeroLayout, { presses: Press[]; typing: number; jump: [number, number]; end: number }> = {
  wide: {
    presses: [
      [0.6, "tab", "nav0", "ring"], [1.8, "tab", "nav1", "ring"], [3, "tab", "chat", "ring"], [4.2, "tab", "set", "ring"], [5.6, "tab", "field", "caret"],
      [8.8, "tab", "plus", "ring"], [9.6, "tab", "perm", "ring"], [10.4, "tab", "model", "ring"], [11.2, "tab", "send", "outline"],
      [13, "back", "model", "ring"], [13.8, "back", "perm", "ring"], [14.6, "back", "plus", "ring"], [15.4, "back", "field", "caret"], [16.6, "back", "set", "ring"],
    ],
    typing: 6.8, jump: [5.6, 16.6], end: 18.4,
  },
  tall: {
    presses: [
      [0.6, "tab", "toggle", "ring"], [2.2, "tab", "field", "caret"],
      [5.4, "tab", "plus", "ring"], [6.2, "tab", "perm", "ring"], [7, "tab", "model", "ring"], [7.8, "tab", "send", "outline"],
      [9.6, "back", "model", "ring"], [10.4, "back", "perm", "ring"], [11.2, "back", "plus", "ring"], [12, "back", "field", "caret"], [13.2, "back", "toggle", "ring"],
    ],
    typing: 3.4, jump: [2.2, 13.2], end: 15,
  },
};

/** The group scene, in beats from its arrival. */
const GROUP: Press[] = [[0.6, "tab", "g0", "ring"], [1.8, "right", "g1", "ring"], [3, "right", "g2", "ring"], [4.2, "tab", "apply", "ring"]];
const GROUP_END = 6;

/** The route scene's arrival, and the group scene's (after the route of that canvas). */
const ROUTE_AT = AT.route + TRANSITION;
const groupStart = (layout: HeroLayout) => ROUTE_AT + ROUTE[layout].end + TRANSITION;

/** Beat the last scene (the group) ends. */
export function focusEnd(g: SceneGeometry): number {
  return groupStart(g.layout) + GROUP_END;
}

export function focusTracks(copy: FocusCopy) {
  return ({ g, close, view }: SceneContext): { tracks: Track[]; camera: Key[] } => {
    const { layout, canvas } = g;
    const route = ROUTE[layout];
    const r0 = ROUTE_AT;
    const t0 = groupStart(layout);
    const end = focusEnd(g);
    const routeBox = g.boxes[`route-${layout}`] ?? g.boxes["route-wide"]!;
    const zoomAt = (cell: string, zoom: number): Pose => view(cell, { x: 0, y: 0, w: canvas.w / zoom, h: canvas.h / zoom }, 1, 99);
    const poses = [
      view("intro", g.boxes.intro!, 1, 1), view("row", g.boxes.row!, 0.85, 2.2), zoomAt("closeup", layout === "tall" ? 1.5 : 3),
      view("route", routeBox, 0.96, 1.6), view("group", g.boxes.group!, 0.9, 2.4),
    ];
    const starts = [0, AT.row, AT.close, AT.route, t0 - TRANSITION];
    const camera: Key[] = [{ at: 0, ...poses[0]! }, ...starts.slice(1).flatMap((at, k): Key[] => [{ at, ...poses[k]! }, { at: at + TRANSITION, ...poses[k + 1]!, ease: "standard" }]), { at: end, ...poses[4]! }];
    const title = g.scopes.title ?? {};
    const row = g.scopes.row ?? {};
    const marks = g.scopes[`route-${layout}`] ?? {};
    const group = g.scopes.group ?? {};
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
    // In step with the draft's reveal (the same beats and curve), so the caret rides its edge.
    caretKeys.push({ at: typing, x: 0 });
    for (let k = 1; k <= steps; k += 1) caretKeys.push({ at: typing + k * step, x: typedW * (k / steps), ease: "decelerate" });
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
      walk("gr", group, GROUP, t0, close),
      ...keyCaps("gk", GROUP, t0, ["tab", "right"], end, close),
      cuts("gv-0", 1, [t0 + GROUP[1]![0]], close), cuts("gv-1", 0, [t0 + GROUP[1]![0], t0 + GROUP[2]![0]], close), cuts("gv-2", 0, [t0 + GROUP[2]![0]], close),
      ...reveal("rv", t0 + GROUP[1]![0] + 0.3, copy.roving, close),
    ];
    return { tracks, camera };
  };
}
