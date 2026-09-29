import type { Key, Track } from "../../heroTimeline";
import { TRANSITION } from "../shared/beats";
import { introTracks } from "../shared/Intro";
import { reveal, revealBeats, select } from "../shared/Reveal";
import type { SceneContext } from "../scene/types";
import { GLASS, SHEETS, zToken, zValue, type LayersCopy } from "./layersCopy";
import { AT, END, looped, namedAt, risesAt, settlesAt } from "./layersTiming";
import { lift, quarter } from "./layersView";


export function layersTracks(copy: LayersCopy) {
  return ({ g, close, view }: SceneContext): { tracks: Track[]; camera: Key[] } => {
    const { canvas, layout } = g;
    const box = g.boxes.screen!;
    const flat = view("screen", box, layout === "tall" ? 0.94 : 0.92, 1.6);
    const tilted = quarter(canvas, box, layout);
    const intro = view("intro", g.boxes.intro!, 1, 1);
    const camera: Key[] = [
      { at: 0, ...intro },
      { at: AT.flat, ...intro },
      { at: AT.flat + TRANSITION, ...flat },
      { at: AT.tilt, ...flat },
      { at: AT.tilt + TRANSITION, ...tilted },
      { at: AT.untilt, ...tilted },
      { at: AT.untilt + TRANSITION, ...flat },
      { at: END, ...flat },
    ];
    const tracks: Track[] = [
      ...introTracks(copy.title, copy.lead, close),
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
        const named = namedAt(k);
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
        // Glass while the camera is square to the window, clear while it is turned.
        const turned = AT.untilt + TRANSITION;
        const glass: Track[] = GLASS.includes(sheet)
          ? [
              {
                select: select(`gp-${k}`),
                keys: looped(
                  [
                    { at: 0, o: 1 },
                    { at: AT.tilt - 0.01, o: 1 },
                    { at: AT.tilt, o: 0 },
                    { at: turned - 0.01, o: 0 },
                    { at: turned, o: 1 },
                  ],
                  close,
                ),
              },
              {
                select: select(`cp-${k}`),
                keys: looped(
                  [
                    { at: 0, o: 0 },
                    { at: AT.tilt - 0.01, o: 0 },
                    { at: AT.tilt, o: 1 },
                    { at: turned - 0.01, o: 1 },
                    { at: turned, o: 0 },
                  ],
                  close,
                ),
              },
            ]
          : [];
        if (k === 0) return [label, ...texts];
        return [
          label,
          ...texts,
          ...glass,
          {
            select: select(`sh-${k}`),
            keys: looped(
              [
                { at: 0, z: rest },
                { at: risesAt(k), z: rest },
                { at: risesAt(k) + AT.rise, z: up },
                { at: settlesAt(k), z: up },
                { at: settlesAt(k) + 1, z: rest },
              ],
              close,
            ),
          },
          {
            select: select(`rim-${k}`),
            keys: looped(
              [
                { at: 0, o: 0 },
                { at: risesAt(k), o: 0 },
                { at: risesAt(k) + 0.4, o: 1 },
                { at: settlesAt(k) + 0.6, o: 1 },
                { at: settlesAt(k) + 1, o: 0 },
              ],
              close,
            ),
          },
        ];
      }),
    ];
    return { tracks, camera };
  };
}

export const LAYERS_END = END;
