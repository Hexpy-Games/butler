import type { CSSProperties } from "react";
import type { Box, Key, Track } from "../../heroTimeline";
import { select } from "./Reveal";
import s from "./shared.module.css";

/** A box the blueprint draws, with the corner radius of the real element (px). */
export type SketchBox = Box & { r: number };

/** Perimeter of a rounded box: the dash that draws its outline. */
export function outlineLength(box: SketchBox): number {
  const r = Math.min(box.r, box.w / 2, box.h / 2);
  return Math.ceil(2 * (box.w + box.h) - (8 - 2 * Math.PI) * r);
}

/** How far construction lines run past a corner (canvas px). */
const OVERSHOOT = 12;
const SIDES = ["t", "r", "b", "l"] as const;

/**
 * The blueprint of one component: every edge of its boxes (the panel, cards,
 * inputs, buttons) as a thin construction line that runs past the corners,
 * then each box's real rounded outline. Pure overlay: absolute lines in the
 * panel, no layout. The first box (the panel) has construction lines only.
 */
export function Sketch({ id, boxes }: { id: string; boxes: SketchBox[] }) {
  return (
    <span className={s.sketch} aria-hidden="true">
      <svg className={s.sketchSvg}>
        {boxes.map((box, i) => (i === 0 ? null : (
          <rect data-hero-specimen="construction-outline" className={s.sketchOutline} data-t={`sk-${id}-${i}-rr`} height={box.h} key={i} rx={Math.min(box.r, box.w / 2, box.h / 2)} ry={Math.min(box.r, box.w / 2, box.h / 2)} width={box.w} x={box.x} y={box.y}
            style={{ "--dash": `${outlineLength(box)}px` } as CSSProperties} />
        )))}
      </svg>
      {boxes.flatMap((box, i) => SIDES.map((side) => {
        const horizontal = side === "t" || side === "b";
        const style = horizontal
          ? { left: `${box.x - OVERSHOOT}px`, top: `${side === "t" ? box.y : box.y + box.h}px`, inlineSize: `${box.w + OVERSHOOT * 2}px` }
          : { left: `${side === "l" ? box.x : box.x + box.w}px`, top: `${box.y - OVERSHOOT}px`, blockSize: `${box.h + OVERSHOOT * 2}px` };
        return <span className={s.sketchLine} data-side={side} data-t={`sk-${id}-${i}-${side}`} key={`${i}-${side}`} style={style as CSSProperties} />;
      }))}
    </span>
  );
}

/**
 * The blueprint's timing: each box's four edges draw one after another from
 * `start` (horizontal edges sweep along x, vertical along y, each from the
 * corner it starts at), the real outline traces after them, both hold while
 * the surface fills in, then retract and fade. Everything resets by `close`.
 */
export function sketchTracks(id: string, boxes: SketchBox[], start: number, retract: number, close: number): Track[] {
  const outlines = boxes.flatMap((box, i): Track[] => (i === 0 ? [] : [{
    select: select(`sk-${id}-${i}-rr`),
    keys: [
      { at: 0, dash: outlineLength(box), o: 0 }, { at: start + i * 0.35 + 0.5, o: 0.8 }, { at: start + i * 0.35 + 1.9, dash: 0, ease: "decelerate" },
      { at: retract + 0.6 + i * 0.1, o: 0.8 }, { at: retract + 1.4 + i * 0.1, o: 0, ease: "accelerate" }, { at: close, dash: outlineLength(box), o: 0 },
    ],
  }]));
  return [...outlines, ...boxes.flatMap((_, i) => SIDES.map((side, j): Track => {
    const at = start + i * 0.35 + j * 0.15;
    const axis = side === "t" || side === "b" ? "sx" : "sy";
    const out = retract + i * 0.1 + j * 0.05;
    const keys: Key[] = [
      { at: 0, [axis]: 0, o: 0 }, { at, [axis]: 0, o: 0.6 }, { at: at + 0.9, [axis]: 1, ease: "decelerate" },
      { at: out, [axis]: 1, o: 0.6 }, { at: out + 0.8, [axis]: 0, o: 0, ease: "accelerate" }, { at: close, [axis]: 0, o: 0 },
    ];
    return { select: select(`sk-${id}-${i}-${side}`), keys };
  }))];
}
