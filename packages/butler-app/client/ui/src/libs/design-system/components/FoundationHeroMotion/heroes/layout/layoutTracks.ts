import { fit, focus, type Key, type Pose, type Track } from "../../heroTimeline";
import { TRANSITION } from "../shared/beats";
import { introTracks } from "../shared/Intro";
import { reveal, select } from "../shared/Reveal";
import { rollerTracks } from "../shared/Roller";
import type { SceneContext } from "../scene/types";
import { DEVICE_H, MODES, WIDTHS, ZOOM, tokenValue, type LayoutCopy } from "./layoutCopy";

/**
 * 10 Layout and platform, "one shell, three modes", beat marks:
 *
 *   0–7.4     Title    a thin page frame around the word, guides down each side
 *   6.8–15.2  Frame    an empty page frame; titlebar, sidebar and gutter draw,
 *                      each measured on the frame's rim
 *   15.2–19.4 Fill     the real shell fills it; the measures dim
 *   19.4–29   Drag     a handle drags the frame 1280 → 1023 → 640 → 375,
 *                      holding at each detent while the shell relays out;
 *                      the camera re-centres the frame (x only on wide)
 *   29–35     Drawer   at 375 the sidebar is a drawer over a scrim; the
 *                      device's insets show top and bottom
 */
const AT = { frame: 6.8, parts: 11, fill: 15.2, drag: 19.4, drawer: 30, insets: 30.4, shut: 32.6, end: 35 } as const;
/** Each drag to a width: [start, arrive] (the shell relays out on arrival). */
const DRAGS: Array<[number, number]> = [[20.2, 22], [23.4, 25.2], [26.6, 28.4]];
const PARTS = ["bar", "side", "gutter"] as const;

const looped = (keys: Key[], close: number): Key[] => {
  const { at: _at, ease: _ease, ...first } = keys[0]!;
  return [...keys, { at: close - 0.01 }, { at: close, ...first }];
};

export function layoutTracks(copy: LayoutCopy) {
  return ({ g, close, view }: SceneContext): { tracks: Track[]; camera: Key[] } => {
    const { layout, canvas } = g;
    const z = ZOOM[layout];
    const stage = g.boxes.shell!;
    const win = g.boxes.win ?? stage;
    const frameAt = (px: number) => ({ x: win.x, y: stage.y, w: px * z, h: stage.h });
    const wideZoom = fit(canvas, stage, 0.92, 1.6);
    const at = (px: number): Pose => {
      const box = frameAt(px);
      return focus(canvas, box, layout === "tall" ? fit(canvas, { ...box, w: box.w + 40 }, 0.9, 3.2) : wideZoom);
    };
    const camera: Key[] = [
      { at: 0, ...view("intro", g.boxes.intro!, 1, 1) }, { at: AT.frame, ...view("intro", g.boxes.intro!, 1, 1) }, { at: AT.frame + TRANSITION, ...view("shell", stage, 0.92, 1.6), ease: "standard" },
      { at: DRAGS[0]![0], ...view("shell", stage, 0.92, 1.6) },
      ...DRAGS.flatMap(([from, to], k): Key[] => [{ at: from + 0.01 }, { at: to + 0.6, ...at(WIDTHS[k + 1]!.px), ease: "standard" }]),
      { at: AT.end, ...at(WIDTHS[3].px) },
    ];
    const shown = (name: string, from: number, to = close - 0.4, o = 1): Track => ({
      select: select(name), keys: [{ at: 0, o: 0 }, { at: from, o: 0 }, { at: from + 0.5, o, ease: "decelerate" }, { at: to, o }, { at: to + 0.4, o: 0 }],
    });
    const fades = (name: string, pairs: Array<[number, number]>, first = 0): Track => ({
      select: select(name), keys: looped([{ at: 0, o: first }, ...pairs.flatMap(([t, o], k): Key[] => [{ at: t, o: k === 0 ? first : pairs[k - 1]![1] }, { at: t + 0.5, o, ease: "standard" }])], close),
    });
    const title: Track[] = [
      { select: select("tf-r"), keys: looped([{ at: 0, dash: 100 }, { at: 1, dash: 100 }, { at: 2.6, dash: 0, ease: "decelerate" }], close) },
      ...["tf-l", "tf-g"].map((name): Track => ({ select: select(name), keys: looped([{ at: 0, dash: 100 }, { at: 2.4, dash: 100 }, { at: 3.6, dash: 0, ease: "decelerate" }], close) })),
    ];
    // The frame: each part's band and its measure on the rim; the shell fills in; the measures dim, then leave for the drag.
    const frame: Track[] = PARTS.flatMap((part, k): Track[] => {
      const t = AT.parts + k * 1.2;
      const label = part === "bar" ? `--titlebar-height ${tokenValue("--titlebar-height")}` : part === "side" ? `--sidebar-width ${tokenValue("--sidebar-width")}` : "--page-container-gutter";
      return [
        fades(`l0-pb-${part}`, [[t, 1], [AT.fill, 0.3], [AT.drag, 0]]), fades(`dm-${part}`, [[t, 1], [AT.fill, 0.3], [AT.drag, 0]]),
        ...reveal(`dl-${part}`, t + 0.3, label, close),
      ];
    });
    const fill: Track[] = ["l0-side", "l0-bar", "l0-c0", "l0-c1", "l0-c2"].map((name, k) => fades(name, [[AT.fill + k * 0.35, 1]]));
    // The drag: the window's edge and the handle follow; on arrival the next layout crossfades in.
    const w = (px: number) => px * z;
    const drags: Track[] = [
      { select: select("win"), keys: looped([{ at: 0, w: w(WIDTHS[0].px), h: DEVICE_H * z }, ...DRAGS.flatMap(([from, to], k): Key[] => [{ at: from, w: w(WIDTHS[k]!.px) }, { at: to, w: w(WIDTHS[k + 1]!.px), ease: "standard" }])], close) },
      { select: select("handle"), keys: looped([{ at: 0, x: 0, o: 0 }, { at: AT.drag, o: 0 }, { at: AT.drag + 0.5, o: 1 }, ...DRAGS.flatMap(([from, to], k): Key[] => [{ at: from, x: w(WIDTHS[k]!.px - WIDTHS[0].px) }, { at: to, x: w(WIDTHS[k + 1]!.px - WIDTHS[0].px), ease: "standard" }]), { at: AT.drawer - 0.6, o: 1 }, { at: AT.drawer, o: 0 }], close) },
      ...WIDTHS.map((_, k): Track => {
        const on = k === 0 ? 0 : DRAGS[k - 1]![1] + 0.2;
        const off = DRAGS[k]?.[1];
        return fades(`l${k}`, [...(k > 0 ? [[on, 1] as [number, number]] : []), ...(off ? [[off + 0.2, 0] as [number, number]] : [])], k === 0 ? 1 : 0);
      }),
      shown("ro", AT.drag - 0.4),
      ...rollerTracks("rw", WIDTHS.map((width) => String(width.px)), 0, [[0, 0], ...DRAGS.map(([, to], k) => [to, k + 1] as [number, number])], g.lines.rw ?? 0, close, 1.2),
      ...rollerTracks("rm", WIDTHS.map((width) => MODES[MODES.indexOf(width.mode)]!), 0, [[0, 0], ...DRAGS.map(([, to], k) => [to + 0.2, k + 1] as [number, number])], g.lines.rm ?? 0, close, 0.4),
    ];
    // The drawer: in over a scrim and out again; the device insets show top and bottom.
    const drawer: Track[] = [
      { select: select("l3-drawer"), keys: looped([{ at: 0, xp: -100 }, { at: AT.drawer, xp: -100 }, { at: AT.drawer + 0.9, xp: 0, ease: "decelerate" }, { at: AT.shut, xp: 0 }, { at: AT.shut + 0.8, xp: -100, ease: "accelerate" }], close) },
      fades("l3-scrim", [[AT.drawer, 1], [AT.shut, 0]]),
      fades("l3-it", [[AT.insets, 1]]), fades("l3-ib", [[AT.insets, 1]]), shown("il", AT.insets + 0.3),
    ];
    return { tracks: [...introTracks(copy.title, copy.lead, close), ...title, ...frame, ...fill, ...drags, ...drawer], camera };
  };
}

export const LAYOUT_END = AT.end;
