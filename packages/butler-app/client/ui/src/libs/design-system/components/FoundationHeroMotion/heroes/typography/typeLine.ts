import { cut, type Key, type Track } from "../../heroTimeline";
import { tagSteps, wipeWidth } from "./LineOverlay";
import { BEATS, LOOP, select } from "./typeChoreography";
import { TYPE_COPY } from "./typeCopy";
import type { LineInfo } from "./typeLines";

/** Built text leaves at the loop from here. */
export const OUT = LOOP + 1.3;
/** Only the number of tag steps is read here, which does not depend on the language. */
const TAG_COPY = TYPE_COPY.en;

/** Beats per glyph of a left-to-right reveal (calm), capped so long lines stay within their moment. */
const glyphBeats = (count: number) => Math.min(0.16, 2 / Math.max(1, count));

/**
 * A window opening left to right glyph by glyph: the window moves right as
 * its content moves back left, pausing at each grapheme's right edge (a
 * decelerating step per glyph). Returns the window and content keys and the
 * beat it is fully open.
 */
function reveal(width: number, edges: number[], start: number): { outer: Key[]; inner: Key[]; end: number } {
  const step = glyphBeats(edges.length);
  const marks = edges.map((edge, k) => ({ at: start + (k + 1) * step, open: Math.min(width, edge) }));
  const end = start + (edges.length + 1) * step;
  const keys = (sign: number): Key[] => [
    { at: 0, x: sign * width }, { at: start, x: sign * width },
    ...marks.map(({ at, open }): Key => ({ at, x: sign * (width - open), ease: "decelerate" })),
    { at: end, x: 0, ease: "decelerate" }, { at: OUT + 0.4, x: 0 }, { at: BEATS - 0.1, x: sign * width },
  ];
  return { outer: keys(-1), inner: keys(1), end };
}

/**
 * One text line, step by step: its tag appears far out in the gutter with a
 * leader to the line; the outline appears glyph by glyph left to right at a
 * neutral size; the role size is applied; the line box shows as a leading
 * band with its measure; the tag counts size, line height and tracking in;
 * the glyphs fill left to right; the real text takes over and the guides
 * recede. Pure overlay: the component never reflows.
 */
export function line(info: LineInfo, a: number, leave: number): Track[] {
  const id = info.id;
  const recede = (from: number, keys: Key[]): Key[] => [...keys, { at: from, o: 1 }, { at: from + 0.6, o: 0, ease: "accelerate" }];
  const edges = info.draw ? info.edges : Array.from({ length: 10 }, (_, k) => ((k + 1) / 10) * info.box.w);
  const width = info.draw ? wipeWidth(info) : info.box.w;
  // Hairline and regular weights skip the outline: their glyphs are revealed filled.
  const first = reveal(width, edges, a + 0.4);
  const sized = first.end + 0.8;
  const second = info.outlined ? reveal(width, edges, sized + 1.4) : null;
  const done = second ? second.end : sized + 1.4;
  const guidesOff = done + 0.6;
  const stepCount = tagSteps(info, TAG_COPY, false).length;
  const steps = [0, first.end, sized + 0.2, sized + 0.8].slice(0, stepCount).concat(BEATS);
  const tracks: Track[] = [
    { select: select(`lb-${id}`), keys: recede(leave, [{ at: 0, x: 8, o: 0 }, { at: a, o: 0 }, { at: a + 0.6, x: 0, o: 1, ease: "decelerate" }]) },
    ...steps.slice(0, -1).map((from, k): Track => ({ select: select(`lb-${id}-${k}`), keys: cut(from, steps[k + 1]!, BEATS) })),
    { select: select(`ll-${id}`), keys: recede(leave, [{ at: 0, sx: 0, o: 0 }, { at: a + 0.2, sx: 0, o: 1 }, { at: a + 1, sx: 1, ease: "decelerate" }]) },
    { select: select(`lband-${id}`), keys: recede(guidesOff, [{ at: 0, sx: 0, o: 0 }, { at: sized, sx: 0, o: 0 }, { at: sized + 0.8, sx: 1, o: 1, ease: "emphasized" }]) },
    { select: select(`lm-${id}`), keys: recede(guidesOff, [{ at: 0, sy: 0, o: 0 }, { at: sized + 0.2, sy: 0, o: 0 }, { at: sized + 0.8, sy: 1, o: 1, ease: "decelerate" }]) },
  ];
  if (!info.draw) {
    // The paragraph reveals its own rows left to right.
    return [...tracks,
      { select: info.select, keys: [{ at: 0, o: 0 }, { at: a + 0.4, o: 1 }, { at: OUT, o: 1 }, { at: OUT + 0.2, o: 0 }, ...first.outer] },
      { select: select("wa-i"), keys: first.inner },
    ];
  }
  const visible = (from: number, off: number): Key[] => [{ at: 0, o: 0 }, { at: from, o: 1 }, { at: off, o: 1 }, { at: off + 0.6, o: 0, ease: "accelerate" }];
  const fill = second ?? first;
  return [
    ...tracks,
    { select: select(`ls-${id}`), keys: [{ at: 0, s: 0.72 }, { at: first.end, s: 0.72 }, { at: sized, s: 1, ease: "emphasized" }, { at: BEATS - 0.1, s: 0.72 }] },
    ...(second ? [
      { select: select(`wo-o-${id}`), keys: [...visible(a + 0.4, done), ...first.outer] },
      { select: select(`wo-i-${id}`), keys: first.inner },
    ] : []),
    { select: select(`wf-o-${id}`), keys: [...visible(second ? sized + 1.4 : a + 0.4, done + 0.5), ...fill.outer] },
    { select: select(`wf-i-${id}`), keys: fill.inner },
    { select: info.select, keys: [{ at: 0, o: 0 }, { at: done, o: 0 }, { at: done + 0.4, o: 1, ease: "decelerate" }, { at: OUT, o: 1 }, { at: OUT + 0.2, o: 0 }] },
  ];
}
