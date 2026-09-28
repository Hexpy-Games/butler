import { fit, focus, type Key, type Track } from "../../heroTimeline";
import { TRANSITION } from "../shared/beats";
import { reveal, select } from "../shared/Reveal";
import type { Prelude, TimelineContext } from "../shared/types";
import { SWATCH_COLUMNS, SWATCHES, type ColorCopy } from "./colorCopy";

/**
 * 01 Color prelude, beat marks:
 *
 *   0–6.4    Intro        "Color" large on the left; strategy, tone and manner,
 *                         intent reveal line by line on the right
 *   6.4–7.8  Out          the text pushes up and out
 *   6.8–10.8 Quarter view the camera glides into an isometric quarter view of
 *                         the empty field
 *   9.6–14   Stickers     role stickers land on the grid from the top left, one
 *                         diagonal at a time
 *   13.6–18  Names        grey token names attach under each sticker in turn
 *   18.4–22.4 Front       the camera returns to a flat front view
 *   21.8–24.8 Wipe        a thin line sweeps left to right; the field left of it
 *                         turns to the dark theme (before and after)
 *   24.8–26.2 Hold        then the components build, topic by topic
 */
const AT = { title: 0.4, lead: 1.4, out: 6.4, iso: 6.8, land: 9.6, names: 13.6, front: 18.4, wipe: 21.8, end: 26.2 } as const;
/** The quarter view: the field plane turned a quarter and tilted back. */
const QUARTER = { rx: 55, rz: -45 } as const;

export function colorPrelude(copy: ColorCopy): Prelude {
  return {
    render: null,
    end: () => AT.end,
    tracks: ({ g, close, finale }: TimelineContext) => {
      const { canvas } = g;
      const intro = g.boxes.intro!;
      const field = g.boxes.field!;
      const front = focus(canvas, intro, 1);
      const quarter = focus(canvas, field, fit(canvas, field, 1.05, 2.2), QUARTER);
      const flat = focus(canvas, field, fit(canvas, field, 0.86, 2));
      const camera: Key[] = [
        { at: 0, ...front }, { at: AT.iso, ...front }, { at: AT.iso + TRANSITION, ...quarter, ease: "standard" },
        { at: AT.front, ...quarter }, { at: AT.front + TRANSITION, ...flat, ease: "standard" }, { at: AT.end, ...flat },
      ];
      const out = (name: string, delay: number): Track => ({
        select: select(name),
        keys: [{ at: 0, y: 0, o: 1 }, { at: AT.out + delay, y: 0, o: 1 }, { at: AT.out + delay + 1, y: -56, o: 0, ease: "accelerate" }, { at: close - 0.01, y: -56, o: 0 }, { at: close, y: 0, o: 1 }],
      });
      const land = (k: number) => AT.land + (Math.floor(k / SWATCH_COLUMNS) + (k % SWATCH_COLUMNS)) * 0.45;
      // The window over the dark field: closed, swept open by the line, then settled on the split for the poster.
      const wipe = (sign: number): Key[] => [
        { at: 0, xp: -sign * 100 }, { at: AT.wipe, xp: -sign * 100 }, { at: AT.wipe + 3, xp: 0, ease: "standard" },
        { at: finale + 0.3, xp: 0 }, { at: finale + 0.3 + TRANSITION, xp: -sign * 50, ease: "standard" }, { at: close - 0.01, xp: -sign * 50 }, { at: close, xp: -sign * 100 },
      ];
      const tracks: Track[] = [
        ...reveal("i-t", AT.title, copy.title, close),
        ...copy.lead.flatMap(([key, text], n) => [...reveal(`i-k${n}`, AT.lead + n, key, close), ...reveal(`i-l${n}`, AT.lead + n + 0.3, text, close)]),
        out("i-title", 0), ...copy.lead.map((_, n) => out(`i-p${n}`, 0.15 * (n + 1))),
        ...SWATCHES.map((_, k): Track => ({
          select: select(`st-${k}`),
          keys: [{ at: 0, s: 1.8, o: 0 }, { at: land(k), s: 1.8, o: 0 }, { at: land(k) + 0.9, s: 1, o: 1, ease: "spring" }, { at: close - 0.01 }, { at: close, s: 1.8, o: 0 }],
        })),
        ...SWATCHES.flatMap((token, k) => reveal(`sn-${k}`, AT.names + k * 0.14, token, close)),
        { select: select("wipe"), keys: wipe(1) },
        { select: select("wipe-in"), keys: wipe(-1) },
        { select: select("wipe-line"), keys: [{ at: 0, o: 0 }, { at: AT.wipe - 0.2, o: 0 }, { at: AT.wipe + 0.2, o: 1 }, { at: AT.wipe + 3, o: 1 }, { at: AT.wipe + 3.6, o: 0 }, { at: finale + 0.6, o: 0 }, { at: finale + 1.6, o: 1 }, { at: close - 0.01 }, { at: close, o: 0 }] },
      ];
      return { tracks, camera };
    },
  };
}
