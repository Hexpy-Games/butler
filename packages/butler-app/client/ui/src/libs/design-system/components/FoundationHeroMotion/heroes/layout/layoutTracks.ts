import { fit, focus, type Key, type Pose, type Track } from "../../heroTimeline";
import { TRANSITION } from "../shared/beats";
import { introTracks } from "../shared/Intro";
import { reveal, select } from "../shared/Reveal";
import { rollerTracks } from "../shared/Roller";
import type { SceneContext } from "../scene/types";
import { DETENTS, MODES, WINDOW, ZOOM, tokenValue, type LayoutCopy } from "./layoutCopy";

/**
 * 10 Layout and platform, "one shell, three modes", beat marks:
 *
 *   0–7.4      Title    "Layout"; shell, modes, platform
 *   6.8–11.4   Window   the camera moves on to Butler at 1280, whole, briefly
 *   11.4–18.8  Measures the camera pushes in on the window's top edge (wide):
 *                       the titlebar's height, the sidebar's width, then it
 *                       pans right to the conversation's column and the handle
 *   18.8–33.6  Drag     the whole window again; the handle drags it to 1023,
 *                       640 and 375; the shell reflows live; at each
 *                       breakpoint the next mode takes over (the sidebar
 *                       becomes a drawer, compact tokens apply); width and
 *                       mode read above the handle
 *   38–42.8    Drawer   at 375 the sidebar opens as a full-width drawer,
 *                       pushing the conversation out, and closes again
 */
const AT = { win: 6.8, bar: 12.8, side: 14.8, pan: 16.2, read: 17.6, handle: 17.4, whole: 19, zoom: 36.2, drawer: 40.4, shut: 43.8, end: 46.4 } as const;
/** Each drag: [start, arrive]; the next mode takes over on arrival. */
const DRAGS: Array<[number, number]> = [[20.6, 23.6], [27, 30], [33.4, 36.2]];
/** The wide push-in: the camera's zoom on the window's top edge. */
const PUSH = 1.6;
/** How long a mode handover crossfades. */
const HANDOVER = 0.4;

const looped = (keys: Key[], close: number): Key[] => {
  const { at: _at, ease: _ease, ...first } = keys[0]!;
  return [...keys, { at: close - 0.01 }, { at: close, ...first }];
};

/** When each mode's layer holds the window: [from, to] in beats. */
function modeSpan(k: number): [number, number] {
  const into = [0, DRAGS[0]![1], DRAGS[1]![1]][k]!;
  const out = [DRAGS[0]![1], DRAGS[1]![1], Infinity][k]!;
  return [into, out];
}

export function layoutTracks(copy: LayoutCopy) {
  return ({ g, close, view }: SceneContext): { tracks: Track[]; camera: Key[] } => {
    const { layout, canvas } = g;
    const z = ZOOM[layout];
    const stage = g.boxes.stage!;
    const win = g.boxes.win!;
    const tall = layout === "tall";
    // Wide: one framing holds the whole drag (the window stays centred). Tall: the far 1280 window, then the phone-width window up close.
    const onStage = view("stage", tall ? win : stage, tall ? 0.94 : 0.9, 3.2);
    const phone = { x: win.x + win.w / 2 - (DETENTS[3].px * z) / 2, y: win.y, w: DETENTS[3].px * z, h: win.h };
    // Wide: the phone-width window whole, its tags above it, as large as the frame's height allows.
    const nearZoom = Math.min(1.6, canvas.h / (win.h + 96));
    const near = tall ? focus(canvas, phone, fit(canvas, phone, 0.9, 3.2)) : focus(canvas, { x: win.x + win.w / 2 - canvas.w / nearZoom / 2, y: win.y - 72, w: canvas.w / nearZoom, h: canvas.h / nearZoom }, nearZoom);
    const intro = view("intro", g.boxes.intro!, 1, 1);
    // Wide push-in boxes on the window's top edge (its rim included): left (titlebar, sidebar), then right (column, handle).
    const crop = { w: canvas.w / PUSH, h: canvas.h / PUSH };
    const top = (x: number): Pose => focus(canvas, { x, y: stage.y - 36, ...crop }, PUSH);
    const left = tall ? onStage : top(win.x - 24);
    const middle = (zoom = PUSH): Pose => focus(canvas, { x: win.x + win.w / 2 - canvas.w / zoom / 2, y: stage.y - 36, w: canvas.w / zoom, h: canvas.h / zoom }, zoom);
    const medium = tall ? onStage : top(win.x + ((WINDOW.w - DETENTS[1].px) / 2) * z - 24);
    const compact = tall ? onStage : middle();
    const right = tall ? onStage : top(win.x + win.w - crop.w + 24);
    // Tall: the camera stays close through the drag, on the window's moving right edge and what reflows beside it,
    // centring on the window once it is narrower than the frame.
    const zt = 2.9;
    const seen = { w: canvas.w / zt, h: canvas.h / zt };
    const follow = (px: number): Pose => focus(canvas, { x: win.x + win.w / 2 + Math.max(0, (px * z) / 2 - seen.w / 2 + 8) - seen.w / 2, y: win.y + win.h / 2 - seen.h / 2, ...seen }, zt);
    const [d1, d2, d3] = DRAGS as [[number, number], [number, number], [number, number]];
    const at = (t: number, pose: Pose, ease = false): Key => ({ at: t, ...pose, ...(ease ? { ease: "standard" as const } : {}) });
    const head: Key[] = [
      { at: 0, ...intro }, { at: AT.win, ...intro }, { at: AT.win + TRANSITION, ...onStage, ease: "standard" },
    ];
    const camera: Key[] = tall
      ? [
        ...head, at(d1[0] - 1.6, onStage), at(d1[0] - 0.2, follow(DETENTS[0].px), true),
        at(d1[1], follow(DETENTS[1].px), true), at(d2[0], follow(DETENTS[1].px)),
        at(d2[1], follow(DETENTS[2].px), true), at(d3[0], follow(DETENTS[2].px)),
        at(d3[1], follow(DETENTS[3].px), true), at(AT.end, follow(DETENTS[3].px)),
      ]
      // Wide: the measures on the window's top edge; then the camera rides the moving right edge (the handle, the readout, the column
      // reflowing), pushes in on the left when the sidebar goes, and holds the narrowing window close, whole, through the last drags.
      : [
        ...head,
        at(AT.bar - 1.4, onStage), at(AT.bar - 0.4, left, true),
        at(AT.pan, left), at(AT.pan + 1.2, right, true),
        at(d1[0], right), at(d1[1], top(win.x + win.w - crop.w + 24 - ((WINDOW.w - DETENTS[1].px) / 2) * z), true),
        at(d1[1] + 0.2, top(win.x + win.w - crop.w + 24 - ((WINDOW.w - DETENTS[1].px) / 2) * z)), at(d1[1] + 1.4, medium, true),
        at(d2[0] - 1.4, medium), at(d2[0] - 0.2, near, true),
        at(d2[1] + 0.2, near), at(d2[1] + 1.4, compact, true),
        at(d3[0] - 1.4, compact), at(d3[0] - 0.2, near, true),
        at(AT.end, near),
      ];
    /** Opacity steps: [beat, value] pairs, each eased over `beats`. */
    const fades = (name: string, pairs: Array<[number, number]>, first = 0, beats = 0.5): Track => ({
      select: select(name),
      keys: looped([{ at: 0, o: first }, ...pairs.flatMap(([t, o], k): Key[] => [{ at: t, o: k === 0 ? first : pairs[k - 1]![1] }, { at: t + beats, o, ease: "standard" }])], close),
    });
    /** A measure: its line draws from its first tick, its tag reveals, both leave at `leave`. */
    const measure = (part: string, at: number, leave: number, label: string, axis: "sx" | "sy"): Track[] => [
      { select: select(`dm-${part}`), keys: looped([{ at: 0, [axis]: 0, o: 1 }, { at, [axis]: 0 }, { at: at + 0.8, [axis]: 1, ease: "decelerate" }, { at: leave, o: 1 }, { at: leave + 0.4, o: 0, ease: "accelerate" }], close) },
      fades(`tg-${part}`, [[at + 0.3, 1], [leave, 0]], 0, 0.4),
      ...reveal(`tl-${part}`, at + 0.4, label, close),
    ];
    const px = (d: number) => d * z;
    const edge = (name: string): Track => ({
      select: select(name),
      keys: looped([{ at: 0, w: px(WINDOW.w), h: px(WINDOW.h) }, ...DRAGS.flatMap(([from, to], k): Key[] => [{ at: from, w: px(DETENTS[k]!.px) }, { at: to, w: px(DETENTS[k + 1]!.px), ease: "standard" }])], close),
    });
    const value = (token: string) => `${token} · ${tokenValue(token).replace(/px$/u, "")}`;
    const tracks: Track[] = [
      ...introTracks(copy.title, copy.lead, close),
      // The window's edge follows the handle; its content reflows at every width.
      edge("win"), edge("rim"),
      ...MODES.map((mode, k) => {
        const [into, out] = modeSpan(k);
        const pairs: Array<[number, number]> = [];
        if (into > 0) pairs.push([into - HANDOVER / 2, 1]);
        if (Number.isFinite(out)) pairs.push([out - HANDOVER / 2, 0]);
        return fades(`ly-${mode}`, pairs, k === 0 ? 1 : 0, HANDOVER);
      }),
      // The measures, each on the edge it belongs to; each leaves before the drag makes it untrue.
      ...measure("bar", AT.bar, AT.side - 0.4, value("--titlebar-height"), "sy"),
      { select: select("ld-bar"), keys: looped([{ at: 0, sy: 0, o: 1 }, { at: AT.bar + 0.2, sy: 0 }, { at: AT.bar + 0.6, sy: 1, ease: "decelerate" }, { at: AT.side - 0.8, o: 1 }, { at: AT.side - 0.4, o: 0, ease: "accelerate" }], close) },
      ...measure("side", AT.side, AT.pan - 0.2, value("--sidebar-width"), "sx"),
      ...measure("read", AT.read, AT.whole, value("--page-max-width-reading"), "sx"),
      // Medium keeps the 760 column (the sidebar is gone); it leaves as the next drag narrows it.
      fades("dm-read-medium", [[d1[1] - HANDOVER / 2, 1], [d2[0] + 0.4, 0]], 0, HANDOVER),
      fades("tg-read-medium", [[d1[1] - HANDOVER / 2, 1], [d2[0] + 0.4, 0]], 0, HANDOVER),
      // Compact: the titlebar's 48 becomes 56 (compact tokens) as the mode takes over.
      fades("dm-bar-compact", [[d2[1] - HANDOVER / 2, 1], [d3[0] - 0.8, 0]], 0, HANDOVER),
      fades("tg-bar-compact", [[d2[1] - HANDOVER / 2, 1], [d3[0] - 0.8, 0]], 0, HANDOVER),
      // The handle and the readout: width rolls through the drag, the mode cuts at each breakpoint.
      { select: select("handle"), keys: looped([{ at: 0, sy: 0, o: 1 }, { at: AT.handle, sy: 0 }, { at: AT.handle + 0.6, sy: 1, ease: "decelerate" }, { at: AT.drawer - 0.6, o: 1 }, { at: AT.drawer, o: 0 }], close) },
      ...["ro", "hu"].flatMap((id): Track[] => [
        fades(id, [[AT.handle + 0.2, 1], [d1[1] + 0.5, 0], [d2[0] - 1.2, 1], [d2[1] + 0.5, 0], [d3[0] - 1.2, 1], [AT.drawer - 1, 0]], 0, 0.5),
        ...rollerTracks(`${id}-w`, DETENTS.map((d) => String(d.px)), 0, [[0, 0], ...DRAGS.map(([, to], k) => [to, k + 1] as [number, number])], g.lines[`${id}-w`] ?? 0, close, DRAGS[0]![1] - DRAGS[0]![0]),
        ...MODES.map((_, k) => {
          const [into, out] = modeSpan(k);
          const pairs: Array<[number, number]> = [];
          if (into > 0) pairs.push([into - HANDOVER / 2, 1]);
          if (Number.isFinite(out)) pairs.push([out - HANDOVER / 2, 0]);
          return fades(`${id}-m${k}`, pairs, k === 0 ? 1 : 0, HANDOVER);
        }),
      ]),
      // Compact at 375: the drawer slides in over the whole width, pushing the conversation out, and back.
      { select: select("ly-drawer"), keys: looped([{ at: 0, xp: -100 }, { at: AT.drawer, xp: -100 }, { at: AT.drawer + 1.2, xp: 0, ease: "emphasized" }, { at: AT.shut, xp: 0 }, { at: AT.shut + 1.2, xp: -100, ease: "emphasized" }], close) },
      { select: select("push-compact"), keys: looped([{ at: 0, xp: 0 }, { at: AT.drawer, xp: 0 }, { at: AT.drawer + 1.2, xp: 100, ease: "emphasized" }, { at: AT.shut, xp: 100 }, { at: AT.shut + 1.2, xp: 0, ease: "emphasized" }], close) },
      ...measure("drawer", AT.drawer + 0.6, AT.shut, "--adaptive-drawer-width · 100vw", "sx"),
    ];
    return { tracks, camera };
  };
}

export const LAYOUT_END = AT.end;
