import { useEffect, useState } from "react";
import { motionEasing, type MotionEasingName } from "../../../lib/motion";
import { cn } from "../../../lib/utils";
import { easingPath } from "../easingPath";
import { slotStyle } from "../heroSequence";
import { HeroReadout } from "./HeroReadout";
import s from "../FoundationHeroMotion.module.css";
import v from "../heroVariants.module.css";

const EASINGS: MotionEasingName[] = ["standard", "decelerate", "accelerate", "emphasized", "spring"];

function easingPaths(): Record<string, string> {
  return Object.fromEntries(EASINGS.map((name) => [name, easingPath(motionEasing(name)) ?? "M0 100 L100 0"]));
}

/**
 * 08 Motion: each easing token plots itself. The dot runs on the token (x
 * linear in time, y on the curve), and a sliding window reveals the curve
 * behind it, so the drawn line is the motion the token produces.
 */
export function MotionHero() {
  const [paths, setPaths] = useState(easingPaths);
  useEffect(() => setPaths(easingPaths()), []);
  return (
    <>
    <span className={v.plot}>
      {EASINGS.map((name, k) => (
        <span className={cn(s.slot, v.curve)} data-slots={5} data-poster={k === 0 ? "" : undefined} key={name}
          style={slotStyle(5, k, {}, { "--hero-ease": `var(--motion-ease-${name})` })}>
          <span className={v.curveWindow}>
            <span className={v.curveInner}>
              <svg className={v.curveSvg} viewBox="0 0 100 100" preserveAspectRatio="none" focusable="false">
                <path d={paths[name]} vectorEffect="non-scaling-stroke" />
              </svg>
            </span>
          </span>
          <span className={v.dotX}><span className={v.dotY} /></span>
        </span>
      ))}
    </span>
    <HeroReadout slots={5} items={EASINGS.map((name) => `--motion-ease-${name}`)} />
    </>
  );
}
