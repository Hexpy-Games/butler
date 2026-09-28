import { fit, focus, type Key, type Track } from "../../heroTimeline";
import { TRANSITION } from "../shared/beats";
import { introTracks } from "../shared/Intro";
import { select } from "../shared/Reveal";
import type { SceneContext } from "../scene/types";
import { GAP, SHEETS, type LayersCopy } from "./layersCopy";

/**
 * 09 Layers, "the exploded stack", beat marks:
 *
 *   0–7.4    Title     three offset copies of the word merge into one
 *   6.8–13   Flat      a real screen, flat and complete, no labels
 *   13–27    Explode   the camera tilts to a quarter view; the sheets separate
 *                      along z one at a time, bottom to top, each with its z
 *   27–30.4  Portal    the menu opens on the dialog's sheet, flashes, and lifts
 *                      to its own popover sheet above
 *   30.8–36  Drag      a card lifts off the page and rises through every sheet
 *                      to the drag layer on top, then drops back
 *   36.4–44  Close     the sheets collapse top to bottom; the camera untilts
 */
const AT = { flat: 6.8, tilt: 13, rise: 17.4, portal: 27.2, lift: 28.4, drag: 30.8, up: 31.2, drop: 34.4, close: 36.4, untilt: 38.8, end: 44 } as const;
const RISE = 1.4;
const QUARTER = { rx: 55, rz: -35 } as const;
const DIALOG = SHEETS.indexOf("dialog");

const looped = (keys: Key[], close: number): Key[] => {
  const { at: _at, ease: _ease, ...first } = keys[0]!;
  return [...keys, { at: close - 0.01 }, { at: close, ...first }];
};

export function layersTracks(copy: LayersCopy) {
  return ({ g, close, view }: SceneContext): { tracks: Track[]; camera: Key[] } => {
    const { canvas, layout } = g;
    const box = g.boxes.screen!;
    const flat = view("screen", box, layout === "tall" ? 0.94 : 0.86, 1.6);
    const quarter = focus(canvas, box, fit(canvas, box, layout === "tall" ? 0.52 : 0.76, 1.4), QUARTER);
    const intro = view("intro", g.boxes.intro!, 1, 1);
    const camera: Key[] = [
      { at: 0, ...intro }, { at: AT.flat, ...intro }, { at: AT.flat + TRANSITION, ...flat, ease: "standard" },
      { at: AT.tilt, ...flat }, { at: AT.tilt + TRANSITION, ...quarter, ease: "standard" },
      { at: AT.untilt, ...quarter }, { at: AT.untilt + TRANSITION, ...flat, ease: "standard" }, { at: AT.end, ...flat },
    ];
    const risesAt = (k: number) => AT.rise + (k - 1) * RISE;
    const collapseAt = (k: number) => AT.close + (SHEETS.length - 1 - k) * 0.4;
    const shown = (name: string, from: number, to: number): Track => ({ select: select(name), keys: looped([{ at: 0, o: 0 }, { at: from, o: 0 }, { at: from + 0.5, o: 1 }, { at: to, o: 1 }, { at: to + 0.5, o: 0 }], close) });
    const tracks: Track[] = [
      ...introTracks(copy.title, copy.lead, close),
      ...[1, 2].map((k): Track => ({ select: select(`tc-${k}`), keys: looped([{ at: 0, y: -8 * k, o: 0.5 / k }, { at: 2.2, y: -8 * k, o: 0.5 / k }, { at: 3.4, y: 0, o: 0, ease: "standard" }], close) })),
      // Each sheet rises to its own height in turn (the popover first only to the dialog's; the drag sheet stays down).
      ...SHEETS.map((sheet, k): Track => {
        const own = k * GAP;
        if (k === 0) return { select: select("sh-0"), keys: [{ at: 0, z: 0 }] };
        if (sheet === "drag") return { select: select(`sh-${k}`), keys: looped([{ at: 0, z: 0 }, { at: AT.up, z: 0 }, { at: AT.drop - 0.8, z: own, ease: "standard" }, { at: AT.drop, z: own }, { at: AT.drop + 1.2, z: 0, ease: "standard" }], close) };
        const first = sheet === "popover" ? DIALOG * GAP : own;
        const keys: Key[] = [{ at: 0, z: 0 }, { at: risesAt(k), z: 0 }, { at: risesAt(k) + 0.9, z: first, ease: "standard" }];
        if (sheet === "popover") keys.push({ at: AT.lift, z: first }, { at: AT.lift + 0.9, z: own, ease: "emphasized" });
        keys.push({ at: collapseAt(k), z: own }, { at: collapseAt(k) + 0.8, z: 0, ease: "standard" });
        return { select: select(`sh-${k}`), keys: looped(keys, close) };
      }),
      ...SHEETS.map((_, k) => shown(`gl-${k}`, AT.tilt + 2, AT.untilt)),
      ...SHEETS.map((sheet, k) => shown(`lb-${k}`, sheet === "drag" ? AT.up + 0.6 : k === 0 ? AT.rise - 0.6 : risesAt(k) + 0.5, sheet === "drag" ? AT.drop + 0.4 : AT.untilt)),
      // The portal rule: the menu on the dialog's sheet flashes, then lifts to its own.
      { select: select("flash"), keys: looped([{ at: 0, o: 0 }, { at: AT.portal, o: 0 }, { at: AT.portal + 0.2, o: 1 }, { at: AT.portal + 0.5, o: 0.3 }, { at: AT.portal + 0.7, o: 1 }, { at: AT.lift, o: 1 }, { at: AT.lift + 0.4, o: 0 }], close) },
      // Drag: the page's card dims as its ghost lifts and rides the drag sheet up, then drops back.
      { select: select("page-card"), keys: looped([{ at: 0, o: 1 }, { at: AT.drag, o: 1 }, { at: AT.drag + 0.3, o: 0.3 }, { at: AT.drop + 1.2, o: 0.3 }, { at: AT.drop + 1.5, o: 1 }], close) },
      { select: select("drag-card"), keys: looped([{ at: 0, s: 1, o: 0 }, { at: AT.drag, s: 1, o: 0 }, { at: AT.drag + 0.3, s: 1.02, o: 1, ease: "standard" }, { at: AT.drop + 1.2, s: 1.02, o: 1 }, { at: AT.drop + 1.5, s: 1, o: 0 }], close) },
    ];
    return { tracks, camera };
  };
}

export const LAYERS_END = AT.end;
