import { motionEasing, type MotionEasingName } from "../../../../lib/motion";
import { easingPath } from "../../easingPath";
import s from "./MotionHero.module.css";

/** The curve itself, small, from the token's live value. */
export function Plot({ ease }: { ease: MotionEasingName }) {
  return (
    <svg className={s.plot} viewBox="-6 -16 112 132">
      <path className={s.plotAxis} d="M0 0V100H100" />
      <path className={s.plotCurve} d={easingPath(motionEasing(ease)) ?? "M0 100L100 0"} />
    </svg>
  );
}
