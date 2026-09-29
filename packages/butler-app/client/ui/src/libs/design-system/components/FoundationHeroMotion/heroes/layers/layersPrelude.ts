import type { Key, Track } from "../../heroTimeline";
import { TRANSITION } from "../shared/beats";
import { introTracks } from "../shared/Intro";
import { reveal, select } from "../shared/Reveal";
import { rollerTracks } from "../shared/Roller";
import type { Prelude, TimelineContext } from "../shared/types";
import { Z, zValue, type LayersCopy } from "./layersCopy";
import { SCREEN, SPREAD } from "./LayersScenes";

/**
 * 09 Layers prelude, beat marks:
 *
 *   0–7.4     Intro     "Layers"; order, separation, flat
 *   6.8–10.8  Sheets    the camera glides to the field: the z tokens drop in
 *                       as numbered sheets, one over the other, stepped flat
 *   14.4–18.4 Screen    the camera travels on to a screen that builds layer by
 *                       layer, each with its z value
 *   22–27     Separate  a slider spreads the layers apart along a flat
 *                       diagonal (their values follow), then closes them
 */
const AT = { field: 6.8, sheets: 9.6, screen: 14.4, page: 16.8, layers: 17.6, slider: 21.6, spread: 22.4, close: 25, end: 28 } as const;

export function layersPrelude(copy: LayersCopy): Pick<Prelude, "end" | "tracks"> {
  return {
    end: () => AT.end,
    tracks: ({ g, close, view }: TimelineContext) => {
      const front = view("intro", g.boxes.intro!, 1, 1);
      const field = view("field", g.boxes.field!, 0.86, 2);
      const screen = view("screen", g.boxes.screen!, 0.88, 2);
      const camera: Key[] = [
        { at: 0, ...front }, { at: AT.field, ...front }, { at: AT.field + TRANSITION, ...field, ease: "standard" },
        { at: AT.screen, ...field }, { at: AT.screen + TRANSITION, ...screen, ease: "standard" }, { at: AT.end, ...screen },
      ];
      const appear = (name: string, at: number, from: Omit<Key, "at"> = { y: -24 }): Track => ({
        select: select(name),
        keys: [{ at: 0, ...from, o: 0 }, { at, ...from, o: 0 }, { at: at + 0.8, x: 0, y: 0, o: 1, ease: "emphasized" }, { at: close - 0.01 }, { at: close, ...from, o: 0 }],
      });
      // Each layer steps k times the spread from the page, flat, while the slider is out.
      // On the tall canvas the layers part mostly downward, where the frame has room.
      const step = g.layout === "tall" ? { x: 0, y: SPREAD.y * 1.6 } : SPREAD;
      const spread = (k: number): Key[] => [
        { at: AT.spread, x: 0, y: 0 }, { at: AT.spread + 2, x: (k + 1) * step.x, y: (k + 1) * step.y, ease: "standard" },
        { at: AT.close, x: (k + 1) * step.x, y: (k + 1) * step.y }, { at: AT.close + 1.4, x: 0, y: 0, ease: "standard" },
      ];
      const tracks: Track[] = [
        ...introTracks(copy.title, copy.lead, close),
        ...Z.flatMap((name, k) => [appear(`zs-${k}`, AT.sheets + k * 0.35), ...reveal(`zs-${k}-v`, AT.sheets + k * 0.35 + 0.3, 3, close), ...reveal(`zs-${k}-n`, AT.sheets + k * 0.35 + 0.5, `--z-${name}`, close)]),
        appear("ly-page", AT.page, { y: 12 }), ...reveal("ly-page-t", AT.page + 0.3, copy.page, close),
        ...SCREEN.flatMap((layer, k): Track[] => {
          const at = AT.layers + k * 0.6;
          const base = appear(`ly-${k}`, at, { y: -16 });
          return [{ ...base, keys: [...base.keys.slice(0, 3), ...spread(k), ...base.keys.slice(3)] }, ...reveal(`ly-${k}-n`, at + 0.4, `--z-${layer} ${zValue(layer)}`, close)];
        }),
        { select: select("sep-thumb"), keys: [{ at: 0, x: 0 }, { at: AT.spread, x: 0 }, { at: AT.spread + 2, x: 96, ease: "standard" }, { at: AT.close, x: 96 }, { at: AT.close + 1.4, x: 0, ease: "standard" }] },
        ...reveal("sep-t", AT.slider, copy.separate, close),
        ...rollerTracks("sep", ["0px", `${SPREAD.x}px`], 0, [[0, 0], [AT.spread + 2, 1], [AT.close + 1.4, 0]], g.lines.sep ?? 0, close, 2),
      ];
      return { tracks, camera };
    },
  };
}
