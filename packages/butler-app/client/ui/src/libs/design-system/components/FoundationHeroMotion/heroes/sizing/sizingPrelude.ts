import { fit, focus, type Key, type Track } from "../../heroTimeline";
import { annotTracks } from "../shared/Annotations";
import { TRANSITION } from "../shared/beats";
import { openingItems } from "../shared/guides";
import { introTracks } from "../shared/Intro";
import { reveal, select, sweep } from "../shared/Reveal";
import type { Prelude, TimelineContext } from "../shared/types";
import { RAILS, type SizingCopy } from "./sizingCopy";
import { FRAME, HIT, TOUCH } from "./SizingScenes";

/**
 * 04 Sizing prelude, beat marks:
 *
 *   0–7.4     Intro      "Sizing"; heights, hit targets, chrome
 *   6.8–10.8  Rails      the camera glides to the field as four rails at
 *                        --control-height-xs … lg draw across it
 *   10.8–13.8 Snap       real controls slide onto the rails, each at its height
 *   14.4–17   Pointer    dashed hit areas bloom around the small icon controls
 *   17–19.8   Touch      the targets grow to --touch-target 44
 *   19.8–23.8 Chrome     the camera travels to an app frame: titlebar band and
 *                        sidebar rows drawn, then measured
 */
const AT = { rails: 9.4, snap: 10.8, hit: 14.4, touch: 17, frame: 19.8, boxes: 21.4, measure: 23.6, end: 26.6 } as const;
const FRAME_BOXES = ["f-title", "f-r0", "f-r1", "f-r2", "f-r3", "f-content"];

export function sizingPrelude(copy: SizingCopy): Omit<Prelude, "render"> {
  return {
    end: () => AT.end,
    tracks: ({ g, close }: TimelineContext) => {
      const { canvas } = g;
      const front = focus(canvas, g.boxes.intro!, 1);
      const field = focus(canvas, g.boxes.field!, fit(canvas, g.boxes.field!, 0.9, 2.2));
      const f = g.boxes.frame!;
      const room = { ...f, x: f.x - 160, y: f.y - 40, w: f.w + 160, h: f.h + 60 };
      const frame = focus(canvas, room, fit(canvas, room, 0.94, 2));
      const camera: Key[] = [
        { at: 0, ...front }, { at: 6.8, ...front }, { at: 6.8 + TRANSITION, ...field, ease: "standard" },
        { at: AT.frame, ...field }, { at: AT.frame + TRANSITION, ...frame, ease: "standard" }, { at: AT.end, ...frame },
      ];
      const mode = (on: boolean): Key[] => [{ at: 0, o: on ? 1 : 0 }, { at: AT.touch - 0.2, o: on ? 1 : 0 }, { at: AT.touch, o: on ? 0 : 1 }, { at: close - 0.01 }, { at: close, o: on ? 1 : 0 }];
      const slide = (name: string, at: number): Track => ({
        select: select(name),
        keys: [{ at: 0, x: 48, o: 0 }, { at, x: 48, o: 0 }, { at: at + 0.9, x: 0, o: 1, ease: "spring" }, { at: close - 0.01 }, { at: close, x: 48, o: 0 }],
      });
      const input = sweep(AT.snap + 3 * 0.6, 0.9, close);
      const tracks: Track[] = [
        ...introTracks(copy.title, copy.lead, close),
        ...RAILS.flatMap((rail, k): Track[] => {
          const at = AT.rails + k * 0.5;
          const edge = (name: string, delay: number): Track => ({ select: select(name), keys: [{ at: 0, sx: 0 }, { at: at + delay, sx: 0 }, { at: at + delay + 1.1, sx: 1, ease: "decelerate" }, { at: close - 0.01 }, { at: close, sx: 0 }] });
          return [
            edge(`rl-t${k}`, 0), edge(`rl-b${k}`, 0.15),
            ...reveal(`rl-n${k}`, at + 0.2, `--control-height-${rail.name}`, close), ...reveal(`rl-v${k}`, at + 0.8, String(rail.px), close),
            slide(`rc-${k}-0`, AT.snap + k * 0.6), slide(`rc-${k}-1`, AT.snap + k * 0.6 + 0.25),
          ];
        }),
        // The control labels reveal as their controls land (rail of each label).
        ...[0, 1, 2, 2, 3].flatMap((rail, n) => reveal(`rc-t${n}`, AT.snap + rail * 0.6 + 0.5 + (n === 3 ? 0.25 : 0), 8, close)),
        { select: select("p-in-lg"), keys: input.outer }, { select: select("p-in-lg-in"), keys: input.inner },
        ...reveal("mode-a-t", AT.hit, copy.pointer, close),
        { select: select("mode-a"), keys: mode(true) }, { select: select("mode-b"), keys: mode(false) },
        ...openingItems(HIT, g.scopes.rails ?? {}, "h", g.layout).flatMap((item, j) => annotTracks(item, AT.hit + 0.2 + j * 0.35, close, AT.touch - 0.4)),
        ...openingItems(TOUCH, g.scopes.rails ?? {}, "t", g.layout).flatMap((item, j) => annotTracks(item, AT.touch + j * 0.35, close, AT.frame + 0.6)),
        ...FRAME_BOXES.flatMap((name, j): Track[] => {
          const open = sweep(AT.boxes + j * 0.25, 0.8, close);
          return [{ select: select(`fb-${name}`), keys: open.outer }, { select: select(`fb-${name}-in`), keys: open.inner }];
        }),
        ...openingItems(FRAME, g.scopes.frame ?? {}, "f", g.layout).flatMap((item, j) => annotTracks(item, AT.measure + j * 0.6, close)),
        { select: select("frame"), keys: [{ at: 0, o: 1 }, { at: AT.end + 0.6, o: 1 }, { at: AT.end + 1.6, o: 0, ease: "accelerate" }, { at: close - 0.01 }, { at: close, o: 1 }] },
      ];
      return { tracks, camera };
    },
  };
}
