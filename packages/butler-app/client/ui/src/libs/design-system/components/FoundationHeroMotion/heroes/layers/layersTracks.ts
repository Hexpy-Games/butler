import { focus, type Box, type Key, type Track } from "../../heroTimeline";
import { TRANSITION } from "../shared/beats";
import { GRID } from "../shared/grid";
import { introTracks } from "../shared/Intro";
import { reveal, revealBeats, select } from "../shared/Reveal";
import type { SceneContext } from "../scene/types";
import { LAYERS, SHEETS, zToken, zValue, type LayersCopy } from "./layersCopy";
import { AT, END, labelAt, looped, rowAt, WARM } from "./layersTiming";
import { lift, quarter } from "./layersView";

const union = (a: Box, b: Box): Box => {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
};

export function layersTracks(copy: LayersCopy) {
  return ({ g, close, view, cells, loop }: SceneContext): { tracks: Track[]; camera: Key[] } => {
    const { canvas, layout } = g;
    const box = g.boxes.screen!;
    const ladder = g.boxes.ladder!;
    const flat = view("screen", box, layout === "tall" ? 0.94 : 0.92, 1.6);
    const zoomed = quarter(canvas, box, layout, true);
    // The finale: the window and its ladder fill the frame, one inset (the grid's margin) on every side.
    const all = union(box, ladder);
    const inset = GRID[layout].margin;
    const done = focus(canvas, all, Math.min((canvas.w - inset * 2) / all.w, (canvas.h - inset * 2) / all.h));
    const spread = AT.spread + AT.spreadFor;
    const collapse = AT.collapse + AT.collapseFor;
    const intro = view("intro", g.boxes.intro!, 1, 1);
    const camera: Key[] = [
      { at: 0, ...intro },
      { at: AT.flat, ...intro },
      { at: AT.flat + TRANSITION, ...flat },
      { at: AT.tilt, ...flat },
      // The camera turns and comes in close together, and stays close through the spread and the collapse.
      { at: AT.tilt + TRANSITION, ...zoomed },
      { at: AT.untilt, ...zoomed },
      { at: AT.untilt + TRANSITION, ...flat },
      // The same window slides sideways (one axis) and backs out to make room for its ladder.
      { at: AT.slide, ...flat },
      { at: AT.slide + TRANSITION, ...done },
      { at: END, ...done },
    ];
    // Pre-paint: the window waits in the intro's frame (all but invisible) while the title plays, so its sheets are
    // rasterised before the camera comes to it and it appears whole in one frame.
    const away = { x: cells.intro!.x - cells.screen!.x, y: cells.intro!.y - cells.screen!.y };
    const tracks: Track[] = [
      ...introTracks(copy.title, copy.lead, close),
      { select: select("warm"), keys: looped([{ at: 0, ...away }, { at: WARM.to, ...away }, { at: WARM.to + 0.01, x: 0, y: 0 }], close) },
      ...[1, 2].map(
        (k): Track => ({
          select: select(`tc-${k}`),
          keys: looped(
            [
              { at: 0, y: -8 * k, o: 0.5 / k },
              { at: 2.2, y: -8 * k, o: 0.5 / k },
              { at: 3.4, y: 0, o: 0 },
            ],
            close,
          ),
        }),
      ),
      ...SHEETS.flatMap((sheet, k): Track[] => {
        // A hair apart while flat, so coplanar sheets keep their order.
        const rest = k * 0.1;
        const up = lift(layout, k);
        const named = labelAt(k);
        const label: Track = {
          select: select(`pin-${k}`),
          keys: looped(
            [
              { at: 0, o: 0 },
              { at: named, o: 0 },
              { at: named + 0.3, o: 1 },
              { at: AT.close, o: 1 },
              { at: AT.close + 0.4, o: 0, ease: "accelerate" },
            ],
            close,
          ),
        };
        const texts = [...reveal(`lb-${k}-t`, named + 0.2, zToken(sheet), close), ...reveal(`lb-${k}-v`, named + 0.2 + revealBeats(zToken(sheet).length), zValue(sheet), close), ...reveal(`lb-${k}-d`, named + 0.6, copy.lives[sheet], close)];
        // While the window waits off stage its planes are all but clear (still drawn, so they are painted); they show before the camera arrives.
        // The planes (leaves, so the sheets keep their 3D) also carry the finished window's fade at the loop.
        const plane: Track = {
          select: select(`pl-${k}`),
          keys: looped([{ at: 0, o: 0.01 }, { at: AT.flat - 0.3, o: 0.01 }, { at: AT.flat - 0.29, o: 1 }, { at: loop + 0.2, o: 1 }, { at: loop + TRANSITION / 2 + 0.2, o: 0, ease: "accelerate" }], close),
        };
        if (k === 0) return [label, ...texts, plane];
        return [
          label,
          ...texts,
          plane,
          {
            select: select(`sh-${k}`),
            keys: looped(
              [
                { at: 0, z: rest },
                { at: AT.spread, z: rest },
                { at: spread, z: up, ease: "standard" },
                { at: AT.collapse, z: up },
                { at: collapse, z: rest, ease: "standard" },
              ],
              close,
            ),
          },
        ];
      }),
      // The ladder, written beside the slid window once it has landed: the highest layer first.
      ...LAYERS.map(
        (_, i): Track => ({
          select: select(`lr-${i}`),
          keys: looped([{ at: 0, o: 0 }, { at: rowAt(i), o: 0 }, { at: rowAt(i) + AT.rowFor, o: 1, ease: "decelerate" }, { at: loop + 0.2, o: 1 }, { at: loop + TRANSITION / 2 + 0.2, o: 0, ease: "accelerate" }], close),
        }),
      ),
    ];
    return { tracks, camera };
  };
}

export const LAYERS_END = END;
