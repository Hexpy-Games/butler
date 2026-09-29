import { motionDuration } from "../../../../lib/motion";

/** Enter and exit of a popover, from the live tokens. */
export function exitTimes() {
  return { enter: motionDuration("base"), exit: motionDuration("exit-fast") };
}
