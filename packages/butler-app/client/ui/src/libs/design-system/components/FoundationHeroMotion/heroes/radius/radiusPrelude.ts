import { fit, focus, type Key, type Track } from "../../heroTimeline";
import { annotTracks } from "../shared/Annotations";
import { TRANSITION } from "../shared/beats";
import { openingItems } from "../shared/guides";
import { introTracks } from "../shared/Intro";
import { reveal, select } from "../shared/Reveal";
import { rollerTracks } from "../shared/Roller";
import type { Prelude, TimelineContext } from "../shared/types";
import { LEVELS, RADII, type RadiusCopy } from "./radiusCopy";
import { NEST, NEST_ANNOTS, SHADOW_ANNOTS } from "./RadiusScenes";

/**
 * 05 Radius and elevation prelude, beat marks:
 *
 *   0–7.4     Intro      "Radius"; corners, nesting, elevation
 *   6.8–10.8  Morph      the camera glides to a square that morphs its corners
 *   10.6–17   …          control 8 → panel 10 → popover 12 → composer 22 →
 *                        pill, a circle riding the corner, the value rolling
 *   17.2–20.4 Nest       button in card in popover in window: outlines drawn
 *                        inside out, each corner's radius on it
 *   20.4–24.4 Ladder     the camera travels to the field: the radius tiles
 *   24.6–30.4 Lift       the three elevations lift off their flat copies,
 *                        each shadow's offset and blur drawn under it
 */
const AT = { lab: 6.8, morph: 10.6, nest: 17.2, field: 20.4, tiles: 22.8, levels: 24.6, lift: 25.8, end: 30.4 } as const;
const MORPH_STEP = 1.4;

export function radiusPrelude(copy: RadiusCopy): Pick<Prelude, "end" | "tracks"> {
  return {
    end: () => AT.end,
    tracks: ({ g, close, view }: TimelineContext) => {
      const front = view("intro", g.boxes.intro!, 1, 1);
      const labBox = g.boxes.lab!;
      const room = g.layout === "wide" ? { ...labBox, x: labBox.x - 120, w: labBox.w + 160 } : labBox;
      const lab = view("lab", room, 0.92, 2);
      const field = view("field", g.boxes.field!, 0.88, 2.2);
      // Tall: the morph fills the portrait frame first; the camera steps down to the whole lab as the nest builds.
      const morphBox = g.boxes.morph;
      const opening: Key[] = g.layout === "tall" && morphBox
        ? [{ at: AT.lab + TRANSITION, ...focus(g.canvas, morphBox, fit(g.canvas, morphBox, 0.9, 2.4)), ease: "standard" }, { at: AT.nest - 0.6 }, { at: AT.nest + 0.8, ...lab, ease: "standard" }]
        : [{ at: AT.lab + TRANSITION, ...lab, ease: "standard" }];
      const camera: Key[] = [
        { at: 0, ...front }, { at: AT.lab, ...front }, ...opening,
        { at: AT.field, ...lab }, { at: AT.field + TRANSITION, ...field, ease: "standard" }, { at: AT.end, ...field },
      ];
      const times = RADII.map((_, k): [number, number] => [AT.morph + k * MORPH_STEP, k]);
      // Each corner shape holds from its mark to the next, crossfading over a third of a beat; the first fades in.
      const shape = (k: number): Key[] => {
        const on = times[k]![0];
        const off = times[k + 1]?.[0];
        const keys: Key[] = [{ at: 0, o: 0 }, { at: on - (k === 0 ? 0.2 : 0.35), o: 0 }, { at: on, o: 1, ease: "standard" }];
        if (off !== undefined) keys.push({ at: off - 0.35, o: 1 }, { at: off, o: 0, ease: "standard" });
        return [...keys, { at: close - 0.01 }, { at: close, o: 0 }];
      };
      const cut = (k: number): Key[] => {
        const on = times[k]![0];
        const off = times[k + 1]?.[0];
        const keys: Key[] = [{ at: 0, o: 0 }, { at: on - 0.01, o: 0 }, { at: on, o: 1 }];
        if (off !== undefined) keys.push({ at: off - 0.01, o: 1 }, { at: off, o: 0 });
        return [...keys, { at: close - 0.01 }, { at: close, o: 0 }];
      };
      const nestAt = (depth: number) => AT.nest + (NEST.length - 1 - depth) * 0.6;
      const nestItems = openingItems(NEST_ANNOTS, g.scopes.nest ?? {}, "n", g.layout);
      const pop = (name: string, at: number): Track => ({
        select: select(name), keys: [{ at: 0, o: 0, s: 0.94 }, { at, o: 0, s: 0.94 }, { at: at + 0.8, o: 1, s: 1, ease: "emphasized" }, { at: close - 0.01 }, { at: close, o: 0, s: 0.94 }],
      });
      const tracks: Track[] = [
        ...introTracks(copy.title, copy.lead, close),
        ...RADII.flatMap((r, k): Track[] => [{ select: select(`mo-${k}`), keys: shape(k) }, { select: select(`mt-${k}`), keys: cut(k) }]),
        ...reveal("mt-rv", AT.morph, RADII[0].token, close),
        ...rollerTracks("mr", RADII.map((r) => r.value), 0, times, g.lines.mr ?? 0, close, 1),
        ...NEST.map((_, depth) => pop(`nb-${depth}`, nestAt(depth))),
        // The notes list the nest outermost first, as NEST_ANNOTS does; each draws with its box.
        ...nestItems.flatMap((item, j) => annotTracks(item, nestAt(j) + 0.3, close)),
        { select: select("lab"), keys: [{ at: 0, o: 1 }, { at: AT.end + 0.6, o: 1 }, { at: AT.end + 1.6, o: 0, ease: "accelerate" }, { at: close - 0.01 }, { at: close, o: 1 }] },
        ...RADII.flatMap((r, k) => [pop(`lt-${k}`, AT.tiles + k * 0.3), ...reveal(`lt-n${k}`, AT.tiles + k * 0.3 + 0.3, r.token, close)]),
        ...LEVELS.flatMap((level, k): Track[] => {
          const at = AT.lift + k * 0.6;
          return [
            pop(`lf-${k}`, AT.levels + k * 0.3), ...reveal(`lv-n${k}`, AT.levels + k * 0.3 + 0.3, level.token, close),
            ...reveal(`lv-l${k}`, AT.levels + k * 0.3 + 0.4, 6, close),
            { select: select(`lu-${k}`), keys: [{ at: 0, y: 6, o: 0 }, { at, y: 6, o: 0 }, { at: at + 1, y: 0, o: 1, ease: "decelerate" }, { at: close - 0.01 }, { at: close, y: 6, o: 0 }] },
          ];
        }),
        ...openingItems(SHADOW_ANNOTS, g.scopes.ladder ?? {}, "s", g.layout).flatMap((item, j) => annotTracks(item, AT.lift + j * 0.6 + 0.6, close, AT.end - 0.4)),
      ];
      return { tracks, camera };
    },
  };
}
