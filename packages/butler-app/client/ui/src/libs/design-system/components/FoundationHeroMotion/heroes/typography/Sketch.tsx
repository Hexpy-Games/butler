import type { CSSProperties } from "react";
import type { Box, Key, Track } from "../../heroTimeline";
import { BEATS, select, type Panel } from "./typeChoreography";
import t from "./TypographyHero.module.css";

/** How far construction lines run past a corner (canvas px). */
const OVERSHOOT = 12;
const SIDES = ["t", "r", "b", "l"] as const;

/**
 * The blueprint of one component: every edge of its boxes (the panel, cards,
 * inputs, buttons) as a thin construction line that runs past the corners.
 * Pure overlay: absolute lines in the panel, no layout.
 */
export function Sketch({ panel, boxes }: { panel: Panel; boxes: Box[] }) {
  return (
    <span className={t.sketch} aria-hidden="true">
      {boxes.flatMap((box, i) => SIDES.map((side) => {
        const horizontal = side === "t" || side === "b";
        const style = horizontal
          ? { left: `${box.x - OVERSHOOT}px`, top: `${side === "t" ? box.y : box.y + box.h}px`, inlineSize: `${box.w + OVERSHOOT * 2}px` }
          : { left: `${side === "l" ? box.x : box.x + box.w}px`, top: `${box.y - OVERSHOOT}px`, blockSize: `${box.h + OVERSHOOT * 2}px` };
        return <span className={t.sketchLine} data-side={side} data-t={`sk-${panel}-${i}-${side}`} key={`${i}-${side}`} style={style as CSSProperties} />;
      }))}
    </span>
  );
}

/**
 * The blueprint's timing: each box's four edges draw one after another from
 * `start` (horizontal edges sweep along x, vertical along y, each from the
 * corner it starts at), hold while the surface fills in, then retract and fade.
 */
export function sketchTracks(panel: Panel, boxes: Box[], start: number, retract: number): Track[] {
  return boxes.flatMap((_, i) => SIDES.map((side, j): Track => {
    const at = start + i * 0.35 + j * 0.15;
    const axis = side === "t" || side === "b" ? "sx" : "sy";
    const out = retract + i * 0.1 + j * 0.05;
    const keys: Key[] = [
      { at: 0, [axis]: 0, o: 0 }, { at, [axis]: 0, o: 0.6 }, { at: at + 0.9, [axis]: 1, ease: "decelerate" },
      { at: out, [axis]: 1, o: 0.6 }, { at: out + 0.8, [axis]: 0, o: 0, ease: "accelerate" }, { at: BEATS - 0.05, [axis]: 0, o: 0 },
    ];
    return { select: select(`sk-${panel}-${i}-${side}`), keys };
  }));
}
