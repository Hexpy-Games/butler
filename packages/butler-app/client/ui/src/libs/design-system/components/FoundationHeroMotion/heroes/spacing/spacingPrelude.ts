import type { Key, Track } from "../../heroTimeline";
import { annotTracks } from "../shared/Annotations";
import { TRANSITION } from "../shared/beats";
import { openingItems } from "../shared/guides";
import { introTracks } from "../shared/Intro";
import { reveal, select, sweep } from "../shared/Reveal";
import type { Prelude, TimelineContext } from "../shared/types";
import { STEPS, type SpacingCopy } from "./spacingCopy";
import { EXTRA, WIRE_ANNOTS } from "./SpacingScenes";

/**
 * 03 Spacing prelude, beat marks:
 *
 *   0–7.4     Intro      "Spacing"; base, scale and rhythm line by line
 *   6.8–10.8  Grid       the camera glides down as the 4px baseline grid
 *                        draws across the field, and pushes into one cell
 *   11.4–16.4 Staircase  pulling back, the named steps extrude xs → 4xl as
 *                        measure blocks, each with its name and value
 *   16.4–20.4 Wireframe  the camera travels to a settings screen drawn as
 *                        blueprint outlines, box by box
 *   20.6–24.2 Measure    its gaps and insets fill as hatched bands under
 *                        brackets with their tokens
 *   24.6–27.4 Breathe    comfortable → compact → comfortable
 */
const AT = { grid: 7.6, cell: 6.8, stairs: 11.6, wire: 16.4, boxes: 17.4, measure: 20.6, breathe: 24.6, end: 28.4 } as const;
const BOXES = ["w-head", "w-card", "w-l1", "w-i1", "w-l2", "w-i2", ...EXTRA.flatMap((k) => [`w-l${k}`, `w-i${k}`]), "w-b1", "w-b2"];

export function spacingPrelude(copy: SpacingCopy): Pick<Prelude, "end" | "tracks"> {
  return {
    end: () => AT.end,
    tracks: ({ g, close, view }: TimelineContext) => {
      const { canvas } = g;
      const front = view("intro", g.boxes.intro!, 1, 1);
      // Pushed into the grid's middle cell, then pulled back to the whole field: one zoom about the field's centre.
      const cell = view("field", { x: 0, y: 0, w: canvas.w / 2.2, h: canvas.h / 2.2 }, 1, 2.2);
      const field = view("field", g.boxes.field!, 0.86, 2);
      // The wireframe with room for its values on both sides.
      const w = g.boxes.wire!;
      const room = g.layout === "wide" ? { ...w, x: w.x - 200, w: w.w + 400 } : w;
      const wire = view("wire", room, 0.96, 2);
      const camera: Key[] = [
        { at: 0, ...front }, { at: AT.cell, ...front }, { at: AT.cell + TRANSITION, ...cell, ease: "standard" },
        { at: AT.stairs - 0.2, ...cell }, { at: AT.stairs + 3, ...field, ease: "standard" },
        { at: AT.wire, ...field }, { at: AT.wire + TRANSITION, ...wire, ease: "standard" }, { at: AT.end, ...wire },
      ];
      const grid = sweep(AT.grid, 2.6, close);
      const breathe = (on: boolean): Key[] => [
        { at: 0, o: on ? 1 : 0 }, { at: AT.breathe, o: on ? 1 : 0 }, { at: AT.breathe + 0.6, o: on ? 0 : 1, ease: "standard" },
        { at: AT.breathe + 2.2, o: on ? 0 : 1 }, { at: AT.breathe + 2.8, o: on ? 1 : 0, ease: "standard" },
      ];
      const items = openingItems(WIRE_ANNOTS, g.scopes.wire ?? {}, "w", g.layout);
      const tracks: Track[] = [
        ...introTracks(copy.title, copy.lead, close),
        { select: select("grid"), keys: grid.outer }, { select: select("grid-in"), keys: grid.inner },
        ...STEPS.flatMap(([name, px], k): Track[] => {
          const at = AT.stairs + k * 0.45;
          return [
            ...reveal(`sp-n${k}`, at, `--space-${name}`, close),
            { select: select(`sp-b${k}`), keys: [{ at: 0, sx: 0 }, { at: at + 0.2, sx: 0 }, { at: at + 1.1, sx: 1, ease: "emphasized" }, { at: close - 0.01 }, { at: close, sx: 0 }] },
            ...reveal(`sp-v${k}`, at + 0.7, String(px), close),
          ];
        }),
        ...BOXES.flatMap((name, j): Track[] => {
          const open = sweep(AT.boxes + j * 0.3, 0.8, close);
          return [{ select: select(`wb-${name}`), keys: open.outer }, { select: select(`wb-${name}-in`), keys: open.inner }];
        }),
        ...reveal("mode-a-t", AT.boxes, copy.comfortable, close),
        ...items.flatMap((item, j) => annotTracks(item, AT.measure + j * 0.55, close, AT.breathe - 0.4)),
        { select: select("wire"), keys: [{ at: 0, o: 1 }, { at: AT.end + 0.6, o: 1 }, { at: AT.end + 1.6, o: 0, ease: "accelerate" }, { at: close - 0.01 }, { at: close, o: 1 }] },
        { select: select("wire-a"), keys: breathe(true) }, { select: select("mode-a"), keys: breathe(true) },
        { select: select("wire-b"), keys: breathe(false) }, { select: select("mode-b"), keys: breathe(false) },
      ];
      return { tracks, camera };
    },
  };
}
