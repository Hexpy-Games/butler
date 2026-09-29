import type { MotionCopy } from "./motionCopy";
import { Exits } from "./Exits";
import { Spring } from "./Spring";
import s from "./MotionHero.module.css";

/** The finale's tail tile: the exit pair over the Switch row, both still. */
export function Tail({ copy }: { copy: MotionCopy }) {
  return (
    <div className={s.tail}>
      <Exits copy={copy} live={false} />
      <Spring copy={copy} live={false} />
    </div>
  );
}
