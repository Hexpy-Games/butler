import type { Key, Pose, Track } from "../../heroTimeline";
import { TRANSITION } from "../shared/beats";
import { introTracks } from "../shared/Intro";
import { reveal, select } from "../shared/Reveal";
import { rollerTracks } from "../shared/Roller";
import type { SceneContext } from "../scene/types";
import { HIT, ICON, RAILS, type SizingCopy } from "./sizingCopy";

/**
 * 04 Sizing, "rails and targets", beat marks (1 beat = --motion-deliberate):
 *
 *   0–7.4     Title    four rails draw under "Sizing" like a staff
 *   6.8–21    Staff    four lanes, each one control height tall; a real
 *                      control drops into each; an off-rail 32 flashes and
 *                      snaps onto md 30
 *   21–33     Touch    a titlebar's 24px icon buttons: the cursor's 30 target
 *                      blooms; the cursor becomes a finger and every target
 *                      grows to 44 together (they touch, never overlap)
 *   33–42     Chrome   the frame's fixed measures on its outer left edge
 */
const AT = { staff: 6.8, drop: 11.8, ghost: 16.6, flash: 17.2, snap: 18.6, touch: 21, enter: 25.2, bloom: 26.4, others: 27.2, finger: 29, grow: 29.8, chrome: 33, dims: 37.2, end: 42 } as const;
/** Lane gap (--space-xl) and the ghost's width, canvas px. */
const LANE_GAP = 20;
const GHOST = { w: 96, h: 32 } as const;

const looped = (keys: Key[], close: number): Key[] => {
  const { at: _at, ease: _ease, ...first } = keys[0]!;
  return [...keys, { at: close - 0.01 }, { at: close, ...first }];
};

/** A hit target of `size`, kept centred on its button (it is laid out at the pointer size). */
const halo = (size: number): Pose => ({ w: size, h: size, x: (HIT.pointer - size) / 2, y: (HIT.pointer - size) / 2 });

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
    // The wrong note: a 32 between sm and md flashes, slides down and settles as 30.
    const between = -(LANE_GAP + GHOST.h) / 2;
    const ghost: Track[] = [
      { select: select("sf-ghost"), keys: looped([{ at: 0, o: 0, y: between, w: GHOST.w, h: GHOST.h }, { at: AT.ghost, o: 0 }, { at: AT.ghost + 0.4, o: 1 }, { at: AT.snap, y: between, h: GHOST.h }, { at: AT.snap + 0.9, y: 0, h: RAILS[2].px, ease: "standard" }], close) },
      { select: select("sf-gw"), keys: looped([{ at: 0, o: 1 }, { at: AT.flash, o: 1 }, { at: AT.flash + 0.3, o: 0.2 }, { at: AT.flash + 0.6, o: 1 }, { at: AT.flash + 0.9, o: 0.2 }, { at: AT.flash + 1.2, o: 1 }, { at: AT.snap + 0.4, o: 1 }, { at: AT.snap + 0.9, o: 0 }], close) },
      { select: select("sf-gr"), keys: looped([{ at: 0, o: 0 }, { at: AT.snap + 0.5, o: 0 }, { at: AT.snap + 0.9, o: 1 }], close) },
      shown("sf-gn", AT.ghost + 0.4, AT.snap + 0.2),
    ];
    // Pointer → touch: the cursor arrives; its target blooms to 30, the others show; it becomes a finger and all grow to 44.
    const grow = { at: AT.grow + 1.2, ...halo(HIT.touch), ease: "emphasized" as const };
    const touch: Track[] = [
      { select: select("cur"), keys: looped([{ at: 0, x: 150, y: 70, o: 0 }, { at: AT.enter, x: 150, y: 70, o: 0 }, { at: AT.enter + 0.3, o: 1 }, { at: AT.bloom - 0.2, x: 0, y: 0, ease: "standard" }, { at: AT.finger, o: 1 }, { at: AT.finger + 0.5, o: 0 }], close) },
      { select: select("fin"), keys: looped([{ at: 0, s: 0.3, o: 0 }, { at: AT.finger, s: 0.3, o: 0 }, { at: AT.finger + 0.6, s: 1, o: 1, ease: "emphasized" }], close) },
      { select: select("tc-h1"), keys: looped([{ at: 0, ...halo(ICON), o: 0 }, { at: AT.bloom, ...halo(ICON), o: 0 }, { at: AT.bloom + 0.8, ...halo(HIT.pointer), o: 1, ease: "decelerate" }, { at: AT.grow, ...halo(HIT.pointer) }, grow], close) },
      ...[0, 2].map((k): Track => ({ select: select(`tc-h${k}`), keys: looped([{ at: 0, ...halo(HIT.pointer), o: 0 }, { at: AT.others, o: 0 }, { at: AT.others + 0.5, o: 1 }, { at: AT.grow, ...halo(HIT.pointer) }, grow], close) })),
      shown("tc-read", AT.bloom), shown("tc-m0", AT.bloom, AT.grow + 0.2), shown("tc-m1", AT.grow + 0.8),
      ...rollerTracks("tcv", [String(HIT.pointer), String(HIT.touch)], 1, [[0, 0], [AT.grow + 1.2, 1]], g.lines.tcv ?? 0, close, 1),
    ];
    // Chrome: the titlebar, then each row, measured on the left edge.
    const chrome: Track[] = [0, 1, 2, 3].map((k): Track => {
      const at = AT.dims + k * 0.6;
      return { select: select(`ch-d${k}`), keys: looped([{ at: 0, o: 0, sy: 0 }, { at, o: 0, sy: 0 }, { at: at + 0.2, o: 1 }, { at: at + 0.7, sy: 1, ease: "decelerate" }], close) };
    });
    return { tracks: [...introTracks(copy.title, copy.lead, close), ...title, ...staff, ...ghost, ...touch, ...chrome], camera };
  };
}

export const SIZING_END = AT.end;
