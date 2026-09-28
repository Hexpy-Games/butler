import type { Key, Track } from "../../heroTimeline";
import { TRANSITION } from "../shared/beats";
import { introTracks } from "../shared/Intro";
import { reveal, select } from "../shared/Reveal";
import type { Prelude, TimelineContext } from "../shared/types";
import { SIZES, type IconCopy } from "./iconCopy";
import { GLYPH_PATHS, GRID_LENGTH } from "./IconScenes";

/**
 * 06 Iconography prelude, beat marks:
 *
 *   0–7.4     Intro     "Iconography"; glyphs, sizes, pairing
 *   6.8–10.8  Keyline   the camera glides to a 24px keyline grid drawing in,
 *                       its padding box and keyline circle
 *   12–15     Glyph     the glyph is drawn stroke by stroke on it
 *   15.4–19.4 Sizes     the camera travels to the field: the glyph at 12, 14,
 *                       16, 20, 24 and 32 on its size boxes, drawn in turn
 *   20.2–22.6 Pairing   each size meets the type it sits beside, on one
 *                       centre line
 *   23.4–28.4 Tone      the glyphs recolor muted → primary → accent → primary
 */
const AT = { lab: 6.8, grid: 9.8, glyph: 12, field: 15.4, sizes: 17.6, pair: 20.2, primary: 23.4, accent: 25, back: 26.8, end: 28.4 } as const;
const GLYPH_DASH = 80;

export function iconPrelude(copy: IconCopy): Pick<Prelude, "end" | "tracks"> {
  return {
    end: () => AT.end,
    tracks: ({ g, close, view }: TimelineContext) => {
      const front = view("intro", g.boxes.intro!, 1, 1);
      const lab = view("lab", g.boxes.lab!, 0.8, 2);
      const field = view("field", g.boxes.field!, 0.9, 2.2);
      const camera: Key[] = [
        { at: 0, ...front }, { at: AT.lab, ...front }, { at: AT.lab + TRANSITION, ...lab, ease: "standard" },
        { at: AT.field, ...lab }, { at: AT.field + TRANSITION, ...field, ease: "standard" }, { at: AT.end, ...field },
      ];
      const draw = (sel: string, len: number, at: number, beats: number): Track => ({
        select: sel, keys: [{ at: 0, dash: len, o: 1 }, { at, dash: len }, { at: at + beats, dash: 0, ease: "decelerate" }, { at: close - 0.01 }, { at: close, dash: len }],
      });
      const fade = (name: string, on: number, off?: number): Track => {
        const out: Key[] = off === undefined ? [] : [{ at: off, o: 1 }, { at: off + 0.6, o: 0, ease: "standard" }];
        return { select: select(name), keys: [{ at: 0, o: 0 }, { at: on, o: 0 }, { at: on + 0.6, o: 1, ease: "standard" }, ...out, { at: close - 0.01 }, { at: close, o: 0 }] };
      };
      const cut = (name: string, on: number, off?: number): Track => {
        const out: Key[] = off === undefined ? [] : [{ at: off - 0.01, o: 1 }, { at: off, o: 0 }];
        return { select: select(name), keys: [{ at: 0, o: 0 }, { at: on - 0.01, o: 0 }, { at: on, o: 1 }, ...out, { at: close - 0.01 }, { at: close, o: 0 }] };
      };
      const tracks: Track[] = [
        ...introTracks(copy.title, copy.lead, close),
        draw(select("k-grid"), GRID_LENGTH, AT.grid, 1.8),
        draw(select("k-pad"), 80, AT.grid + 1, 1),
        draw(select("k-circle"), 63, AT.grid + 1.4, 1.1),
        ...reveal("k-n0", AT.grid + 0.6, copy.grid, close), ...reveal("k-n1", AT.grid + 1.4, copy.padding, close),
        ...Array.from({ length: GLYPH_PATHS }, (_, n) => draw(`${select("k-glyph")} path:nth-of-type(${n + 1})`, GLYPH_DASH, AT.glyph + n * 0.55, 1.3)),
        ...reveal("k-n2", AT.glyph + 0.4, copy.stroke, close),
        { select: select("lab"), keys: [{ at: 0, o: 1 }, { at: AT.end + 0.6, o: 1 }, { at: AT.end + 1.6, o: 0, ease: "accelerate" }, { at: close - 0.01 }, { at: close, o: 1 }] },
        ...SIZES.flatMap((size, k): Track[] => {
          const at = AT.sizes + k * 0.3;
          const pair = AT.pair + k * 0.25;
          const tone = 0.1 * k;
          return [
            { select: select(`il-b${k}`), keys: [{ at: 0, o: 0, s: 0.9 }, { at, o: 0, s: 0.9 }, { at: at + 0.6, o: 1, s: 1, ease: "emphasized" }, { at: close - 0.01 }, { at: close, o: 0, s: 0.9 }] },
            draw(`${select(`il-muted-${k}`)} path`, GLYPH_DASH, at + 0.2, 1),
            ...reveal(`il-n${k}`, at + 0.1, `--icon-size-${size.name}`, close), ...reveal(`il-v${k}`, at + 0.5, String(size.px), close),
            { select: select(`il-c${k}`), keys: [{ at: 0, sx: 0 }, { at: pair, sx: 0 }, { at: pair + 0.9, sx: 1, ease: "decelerate" }, { at: close - 0.01 }, { at: close, sx: 0 }] },
            { select: select(`il-t${k}`), keys: [{ at: 0, x: -10, o: 0 }, { at: pair + 0.2, x: -10, o: 0 }, { at: pair + 0.9, x: 0, o: 1, ease: "decelerate" }, { at: close - 0.01 }, { at: close, x: -10, o: 0 }] },
            ...reveal(`il-w${k}`, pair + 0.3, copy.pairs[k]!, close),
            fade(`il-primary-${k}`, AT.primary + tone), fade(`il-accent-${k}`, AT.accent + tone, AT.back + tone),
          ];
        }),
        cut("im-0", AT.sizes, AT.primary), cut("im-2", AT.accent, AT.back),
        { select: select("im-1"), keys: [{ at: 0, o: 0 }, { at: AT.primary - 0.01, o: 0 }, { at: AT.primary, o: 1 }, { at: AT.accent - 0.01, o: 1 }, { at: AT.accent, o: 0 }, { at: AT.back - 0.01, o: 0 }, { at: AT.back, o: 1 }, { at: close - 0.01 }, { at: close, o: 0 }] },
      ];
      return { tracks, camera };
    },
  };
}
