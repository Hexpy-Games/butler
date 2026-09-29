import { type SizingCopy } from "./sizingCopy";
import { Staff } from "./Staff";
import s from "./SizingHero.module.css";

/** Scene 2: the staff; a control drops into each lane. */
export function StaffScene({ copy }: { copy: SizingCopy }) {
  return <div className={s.staffStage} data-m="staff"><Staff copy={copy} name="sf" /></div>;
}
