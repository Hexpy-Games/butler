import { fit, focus, type Key, type Track } from "../../heroTimeline";
import { TRANSITION } from "../shared/beats";
import { introTracks } from "../shared/Intro";
import { reveal, select } from "../shared/Reveal";
import type { HeroLayout } from "../shared/grid";
import type { Prelude, TimelineContext } from "../shared/types";
import { SWATCH_COLUMNS, SWATCHES, type ColorCopy } from "./colorCopy";

/**
 * 01 Color prelude, beat marks:
 *
 *   0–7.4     Intro        "Color" large on the left; strategy, tone and
 *                          manner, intent reveal line by line on the right
 *   6.8–10.8  Quarter view the text pushes up and out; the camera glides into
 *                          an isometric quarter view of the empty page
 *   10.6–15   Stickers     the role stickers come down from above, curled on
 *                          one side, and press flat edge to edge, in a ripple
 *                          that visibly travels the diagonals from the top left
 *   14.8–17.8 Names        grey token names attach under each sticker in turn
 *   18–22     Front        the camera returns to a flat front view
 *   22.2–25.7 Wipe         a line sweeps the whole frame into the other theme
 *   26.8–30.3 Back         and sweeps once more, back to the page's theme
 *   30.3–31.2 Hold         then the components build, topic by topic
 */
const AT = { iso: 6.8, land: 10.6, names: 14.8, front: 18, wipe: 22.2, back: 26.8, end: 31.2 } as const;
/** Beats between one diagonal of stickers and the next (the ripple travels the grid over ~2.8 beats), and a sticker's curl-and-press. */
const RIPPLE = 0.4;
const PRESS = 1.6;
/** Beats the wipe line takes to cross the frame. */
const WIPE = 3;
/** The quarter view: the field plane turned a quarter and tilted back. */
const QUARTER = { rx: 55, rz: -45 } as const;

export function colorPrelude(copy: ColorCopy, posterZoom: (layout: HeroLayout) => number): Pick<Prelude, "end" | "tracks"> {
  return {
    end: () => AT.end,
    tracks: ({ g, close, view }: TimelineContext) => {
      const { canvas } = g;
      const intro = g.boxes.intro!;
      const field = g.boxes.field!;
      const front = view("intro", intro, 1, 1);
      // The portrait frame fills with the grid's middle (its far corners crop).
      const quarter = focus(canvas, field, fit(canvas, field, g.layout === "tall" ? 1.45 : 1.05, 2.2), QUARTER);
      const flat = view("field", field, 0.86, 2);
      const camera: Key[] = [
        { at: 0, ...front }, { at: AT.iso, ...front }, { at: AT.iso + TRANSITION, ...quarter, ease: "standard" },
        { at: AT.front, ...quarter }, { at: AT.front + TRANSITION, ...flat, ease: "standard" }, { at: AT.end, ...flat },
      ];
      // A cascading ripple along the diagonals ("촤르르륵"), each sticker overlapping the next.
      const columns = g.layout === "tall" ? SWATCH_COLUMNS - 1 : SWATCH_COLUMNS;
      const land = (k: number) => AT.land + (Math.floor(k / columns) + (k % columns)) * RIPPLE + (k % columns) * 0.05;
      // The window over the other theme is several frames wide; key its edge where it crosses the visible frame, so the
      // line crosses the frame in time: open left to right, then its trailing edge crosses again (the page's theme returns).
      const zoom = flat.s ?? 1;
      const span = field.w + 3 * canvas.w * posterZoom(g.layout);
      const [enter, leave] = [0.5 - canvas.w / zoom / 2 / span - 0.01, 0.5 + canvas.w / zoom / 2 / span + 0.01];
      const wipe = (sign: number): Key[] => [
        { at: 0, xp: -sign * 100 }, { at: AT.wipe - 0.01, xp: -sign * 100 }, { at: AT.wipe, xp: sign * (enter - 1) * 100 }, { at: AT.wipe + WIPE, xp: sign * (leave - 1) * 100, ease: "standard" },
        { at: AT.wipe + WIPE + 0.01, xp: 0 }, { at: AT.back - 0.01, xp: 0 }, { at: AT.back, xp: sign * enter * 100 },
        { at: AT.back + WIPE, xp: sign * leave * 100, ease: "standard" }, { at: AT.back + WIPE + 0.01, xp: -sign * 100 },
      ];
      const line = (from: number): Key[] => [{ at: 0, o: 0 }, { at: from, o: 0 }, { at: from + 0.2, o: 1 }, { at: from + WIPE - 0.2, o: 1 }, { at: from + WIPE, o: 0 }];
      const tracks: Track[] = [
        ...introTracks(copy.title, copy.lead, close),
        ...SWATCHES.flatMap((_, k): Track[] => {
          const at = land(k);
          // Down from above the page (plane x = -y is screen up in the quarter view), curled; then pressed flat left to right.
          return [
            { select: select(`st-${k}`), keys: [{ at: 0, x: 170, y: -170, o: 0 }, { at, x: 170, y: -170, o: 0 }, { at: at + 0.15, o: 1 }, { at: at + PRESS * 0.55, x: 0, y: 0, ease: "decelerate" }, { at: close - 0.01 }, { at: close, x: 170, y: -170, o: 0 }] },
            { select: select(`st-${k}-r`), keys: [{ at: 0, ry: -80 }, { at: at + PRESS * 0.4, ry: -80 }, { at: at + PRESS, ry: 0, ease: "decelerate" }, { at: close - 0.01 }, { at: close, ry: -80 }] },
            { select: select(`st-${k}-c`), keys: [{ at: 0, o: 1 }, { at: at + PRESS * 0.4, o: 1 }, { at: at + PRESS, o: 0, ease: "decelerate" }, { at: close - 0.01 }, { at: close, o: 1 }] },
            { select: select(`st-${k}-f`), keys: [{ at: 0, o: 0 }, { at: at + PRESS, o: 0 }, { at: at + PRESS + 0.01, o: 1 }, { at: close - 0.01 }, { at: close, o: 0 }] },
          ];
        }),
        ...SWATCHES.flatMap((token, k) => reveal(`sn-${k}`, AT.names + k * 0.1, token, close)),
        { select: select("wipe"), keys: wipe(1) },
        { select: select("wipe-in"), keys: wipe(-1) },
        { select: select("wipe-line"), keys: line(AT.wipe) },
        { select: select("wipe-back"), keys: line(AT.back) },
      ];
      return { tracks, camera };
    },
  };
}
