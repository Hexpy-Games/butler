import type { Key, Track } from "../../heroTimeline";
import { TRANSITION } from "../shared/beats";
import { introTracks } from "../shared/Intro";
import { reveal, select } from "../shared/Reveal";
import type { Prelude, TimelineContext } from "../shared/types";
import { RING_TOKENS, type FocusCopy } from "./focusCopy";

/**
 * 07 Focus ring prelude, beat marks:
 *
 *   0–7.4     Intro      "Focus ring"; one ring, keyboard, shape
 *   6.8–10.8  Row        the camera glides to a row of real controls
 *   11.6–16.4 Tab        the Tab key presses and one accent ring walks the tab
 *                        order, wrapping back to the first control
 *   17.6–20.6 Shift+Tab  Shift+Tab walks the ring back
 *   21.4–28.4 Close-up   the camera travels on to the first control, close:
 *                        the ring's 2px width bracketed, its color named, its
 *                        corner the control's own
 */
const AT = { row: 6.8, controls: 9.4, close: 21.4, notes: 24.6, end: 28.4 } as const;
/** Each key press and the control the ring lands on. */
const PRESSES: Array<[at: number, ring: number, back: boolean]> = [
  [11.6, 0, false], [12.8, 1, false], [14, 2, false], [15.2, 3, false], [16.4, 0, false],
  [17.6, 3, true], [18.6, 2, true], [19.6, 1, true], [20.6, 0, true],
];

export function focusPrelude(copy: FocusCopy): Pick<Prelude, "end" | "tracks"> {
  return {
    end: () => AT.end,
    tracks: ({ g, close, finale, view }: TimelineContext) => {
      const front = view("intro", g.boxes.intro!, 1, 1);
      const row = view("field", g.boxes.field!, 0.9, 2.2);
      const cu = g.boxes.closeup!;
      const room = g.layout === "wide" ? { ...cu, x: cu.x - 280, w: cu.w + 300, y: cu.y - 30, h: cu.h + 60 } : { ...cu, x: cu.x + cu.w / 2 - 80, w: 160, y: cu.y - 118, h: cu.h + 236 };
      const closeUp = view("closeup", room, 0.92, 3);
      const camera: Key[] = [
        { at: 0, ...front }, { at: AT.row, ...front }, { at: AT.row + TRANSITION, ...row, ease: "standard" },
        { at: AT.close, ...row }, { at: AT.close + TRANSITION, ...closeUp, ease: "standard" }, { at: AT.end, ...closeUp },
      ];
      // A layer shown from each press that selects it until the next press; the last holds until the builds.
      const windows = (match: (press: (typeof PRESSES)[number], j: number) => boolean, until = AT.end + 1): Key[] => {
        const keys: Key[] = [{ at: 0, o: 0 }];
        PRESSES.forEach((press, j) => {
          const next = PRESSES[j + 1]?.[0] ?? until;
          if (!match(press, j)) return;
          keys.push({ at: press[0] - 0.01, o: 0 }, { at: press[0], o: 1 }, { at: next - 0.01, o: 1 }, { at: next, o: 0 });
        });
        return [...keys, { at: close - 0.01 }, { at: close, o: 0 }];
      };
      const counts = [1, 2, 3, 4, 1, 4, 3, 2, 1];
      const pop = (name: string, at: number): Track => ({
        select: select(name), keys: [{ at: 0, o: 0, s: 0.92 }, { at, o: 0, s: 0.92 }, { at: at + 0.8, o: 1, s: 1, ease: "spring" }, { at: close - 0.01 }, { at: close, o: 0, s: 0.92 }],
      });
      const shown = (name: string, from: number, to: number): Track => ({
        select: select(name), keys: [{ at: 0, o: 0 }, { at: from, o: 0 }, { at: from + 0.6, o: 1, ease: "decelerate" }, { at: to, o: 1 }, { at: to + 0.6, o: 0, ease: "accelerate" }],
      });
      const press = (name: string, back: boolean): Track => ({
        select: select(name),
        keys: [{ at: 0, s: 1 }, ...PRESSES.filter((p) => p[2] === back).flatMap(([at]): Key[] => [{ at: at - 0.5, s: 1 }, { at: at - 0.25, s: 0.9, ease: "accelerate" }, { at: at + 0.2, s: 1, ease: "spring" }])],
      });
      const tracks: Track[] = [
        ...introTracks(copy.title, copy.lead, close),
        ...[0, 1, 2, 3].map((k) => pop(`p-c${k}`, AT.controls + k * 0.3)),
        ...reveal("c0-t", AT.controls + 0.4, copy.continue, close),
        ...reveal("c3-a", AT.controls + 1.3, copy.week, close), ...reveal("c3-b", AT.controls + 1.5, copy.month, close),
        { select: select("key-tab"), keys: [{ at: 0, o: 0 }, { at: 10.6, o: 0 }, { at: 11.1, o: 1 }, { at: 17.2, o: 1 }, { at: 17.4, o: 0 }, { at: finale + 4, o: 0 }, { at: finale + 4.6, o: 1 }, { at: close - 0.01 }, { at: close, o: 0 }] },
        { select: select("key-back"), keys: [{ at: 0, o: 0 }, { at: 17.2, o: 0 }, { at: 17.4, o: 1 }, { at: AT.end + 0.6, o: 1 }, { at: AT.end + 1, o: 0 }] },
        press("key-tab", false), press("key-back", true),
        ...[1, 2, 3, 4].map((n): Track => {
          const keys = windows((_, j) => counts[j] === n);
          // The settled poster shows 1/4 again.
          if (n === 1) keys.splice(keys.length - 2, 0, { at: finale + 4, o: 0 }, { at: finale + 4.6, o: 1 });
          return { select: select(`cnt-${n}`), keys };
        }),
        ...[0, 1, 2, 3].map((k): Track => ({ select: select(`g-r${k}-0`), keys: windows(([, ring]) => ring === k) })),
        { select: select("pring"), keys: [{ at: 0, o: 0 }, { at: finale + 4, o: 0 }, { at: finale + 4.6, o: 1 }, { at: close - 0.01 }, { at: close, o: 0 }] },
        shown("wm", AT.notes, AT.end + 1), shown("wn", AT.notes + 0.2, AT.end + 1), shown("cn", AT.notes + 0.9, AT.end + 1),
        ...reveal("cu-t", AT.close + 2.4, copy.continue, close),
        ...reveal("wn-t", AT.notes + 0.3, 20, close), ...reveal("cn-t", AT.notes + 1, 18, close),
        ...RING_TOKENS.flatMap(([token, value], k) => [...reveal(`ft-n${k}`, AT.controls + 0.8 + k * 0.4, token, close), ...reveal(`ft-v${k}`, AT.controls + 1.1 + k * 0.4, value, close)]),
      ];
      return { tracks, camera };
    },
  };
}
