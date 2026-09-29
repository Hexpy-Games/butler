import type { Key, Track } from "../../heroTimeline";
import { TRANSITION } from "../shared/beats";
import { introTracks } from "../shared/Intro";
import { reveal, select } from "../shared/Reveal";
import { rollerTracks } from "../shared/Roller";
import type { SceneContext } from "../scene/types";
import { HIT, RAILS, type SizingCopy } from "./sizingCopy";

/**
 * 04 Sizing, "rails and targets", beat marks (1 beat = --motion-deliberate):
 *
 *   0–7.4     Title    four rails draw under "Sizing" like a staff
 *   6.8–19    Staff    four lanes, each one control height tall; a real
 *                      control drops into each
 *   19–31     Touch    the real titlebar's icon buttons: the cursor's 30 target
 *                      blooms; the cursor becomes a finger and every target
 *                      grows to 44 together, the buttons moving apart as on
 *                      a touch screen (never overlapping)
 *   31–40     Chrome   the frame's fixed measures on its outer left edge
 */
const AT = { staff: 6.8, drop: 11.8, touch: 19, enter: 23.2, bloom: 24.4, others: 25.2, finger: 27, grow: 27.8, chrome: 31, dims: 35.2, end: 40 } as const;
/** The bar around touch's 44: the target and --space-md (the phone titlebar's 56). */
const TOUCH_BAR = HIT.touch + 12;

const looped = (keys: Key[], close: number): Key[] => {
  const { at: _at, ease: _ease, ...first } = keys[0]!;
  return [...keys, { at: close - 0.01 }, { at: close, ...first }];
};

export function sizingTracks(copy: SizingCopy) {
  return ({ g, close, view }: SceneContext): { tracks: Track[]; camera: Key[] } => {
    const poses = {
      intro: view("intro", g.boxes.intro!, 1, 1), staff: view("staff", g.boxes.staff!, 0.86, 2),
      touch: view("touch", g.boxes.touch!, 0.84, 2.6), chrome: view("chrome", g.boxes.chrome!, 0.86, 2),
    };
    const camera: Key[] = [
      { at: 0, ...poses.intro }, { at: AT.staff, ...poses.intro }, { at: AT.staff + TRANSITION, ...poses.staff, ease: "standard" },
      { at: AT.touch, ...poses.staff }, { at: AT.touch + TRANSITION, ...poses.touch, ease: "standard" },
      { at: AT.chrome, ...poses.touch }, { at: AT.chrome + TRANSITION, ...poses.chrome, ease: "standard" }, { at: AT.end, ...poses.chrome },
    ];
    const shown = (name: string, from: number, to = close - 0.4): Track => ({
      select: select(name), keys: [{ at: 0, o: 0 }, { at: from, o: 0 }, { at: from + 0.5, o: 1, ease: "decelerate" }, { at: to, o: 1 }, { at: to + 0.4, o: 0 }],
    });
    const title: Track[] = [0, 1, 2, 3].map((k) => ({ select: select(`tr-${k}`), keys: looped([{ at: 0, dash: 100 }, { at: 0.9 + k * 0.3, dash: 100 }, { at: 2.1 + k * 0.3, dash: 0, ease: "decelerate" }], close) }));
    // The staff: labels, then one control drops into each lane; its lane lights as it lands.
    const staff: Track[] = RAILS.flatMap((rail, k): Track[] => {
      const at = AT.drop + k * 1.1;
      return [
        ...reveal(`sf-lt${k}`, AT.staff + TRANSITION + 0.2 + k * 0.25, `${rail.name} ${rail.px}`, close),
        { select: select(`sf-c${k}`), keys: looped([{ at: 0, y: -72, o: 0 }, { at, y: -72, o: 0 }, { at: at + 0.2, o: 1 }, { at: at + 0.8, y: 0, ease: "standard" }], close) },
        { select: select(`sf-f${k}`), keys: looped([{ at: 0, o: 0 }, { at: at + 0.7, o: 0 }, { at: at + 0.9, o: 1 }, { at: at + 1.7, o: 0.35, ease: "standard" }], close) },
      ];
    });
    // Pointer → touch: the cursor arrives; its target blooms at 30, the other shows; it becomes a finger and every target grows to 44.
    const size = (px: number) => ({ w: px, h: px });
    const bar = g.boxes["tc-bar"]?.h ?? 48;
    const target = (k: number): Track => ({ select: select(`tc-t${k}`), keys: looped([{ at: 0, ...size(HIT.pointer) }, { at: AT.grow, ...size(HIT.pointer) }, { at: AT.grow + 1.2, ...size(HIT.touch), ease: "emphasized" }], close) });
    const touch: Track[] = [
      { select: select("cur"), keys: looped([{ at: 0, x: 150, y: 70, o: 0 }, { at: AT.enter, x: 150, y: 70, o: 0 }, { at: AT.enter + 0.3, o: 1 }, { at: AT.bloom - 0.2, x: 0, y: 0, ease: "standard" }, { at: AT.finger, o: 1 }, { at: AT.finger + 0.5, o: 0 }], close) },
      { select: select("fin"), keys: looped([{ at: 0, s: 0.3, o: 0 }, { at: AT.finger, s: 0.3, o: 0 }, { at: AT.finger + 0.6, s: 1, o: 1, ease: "emphasized" }], close) },
      target(0), target(1),
      { select: select("tc-bar"), keys: looped([{ at: 0, w: 1, h: bar }, { at: AT.grow, h: bar }, { at: AT.grow + 1.2, h: Math.max(bar, TOUCH_BAR), ease: "emphasized" }], close) },
      { select: select("tc-h1"), keys: looped([{ at: 0, s: 0.8, o: 0 }, { at: AT.bloom, s: 0.8, o: 0 }, { at: AT.bloom + 0.8, s: 1, o: 1, ease: "decelerate" }], close) },
      { select: select("tc-h0"), keys: looped([{ at: 0, o: 0 }, { at: AT.others, o: 0 }, { at: AT.others + 0.5, o: 1 }], close) },
      shown("tc-read", AT.bloom), shown("tc-m0", AT.bloom, AT.grow + 0.2), shown("tc-m1", AT.grow + 0.8),
      ...rollerTracks("tcv", [String(HIT.pointer), String(HIT.touch)], 1, [[0, 0], [AT.grow + 1.2, 1]], g.lines.tcv ?? 0, close, 1),
    ];
    // Chrome: the titlebar, then each row, measured on the left edge.
    const chrome: Track[] = [0, 1, 2, 3].map((k): Track => {
      const at = AT.dims + k * 0.6;
      return { select: select(`ch-d${k}`), keys: looped([{ at: 0, o: 0, sy: 0 }, { at, o: 0, sy: 0 }, { at: at + 0.2, o: 1 }, { at: at + 0.7, sy: 1, ease: "decelerate" }], close) };
    });
    return { tracks: [...introTracks(copy.title, copy.lead, close), ...title, ...staff, ...touch, ...chrome, shown("ch-lg", AT.dims + 0.6)], camera };
  };
}

export const SIZING_END = AT.end;
