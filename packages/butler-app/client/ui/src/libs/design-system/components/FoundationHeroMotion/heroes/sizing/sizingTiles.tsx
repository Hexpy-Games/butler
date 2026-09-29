import { HIT, type SizingCopy } from "./sizingCopy";
import { TouchBar } from "./TouchBar";
import { FormRow } from "./FormRow";
import { Frame } from "./Frame";
import { Staff } from "./Staff";
import s from "./SizingHero.module.css";

/** Finale tiles. */
export const StaffTile = ({ copy }: { copy: SizingCopy }) => <div className={s.staffTile}><Staff copy={copy} /></div>;

export const FrameTile = ({ copy }: { copy: SizingCopy }) => <div className={s.frameTile}><Frame copy={copy} space /></div>;

export const HaloTile = ({ copy }: { copy: SizingCopy }) => (
  <div className={s.captioned} data-kind="halo">
    <TouchBar copy={copy} touch />
    <span className={s.caption}>{`--control-hit-target ${HIT.pointer} → ${copy.touch} ${HIT.touch}`}</span>
  </div>
);

export const FormTile = ({ copy }: { copy: SizingCopy }) => (
  <div className={s.captioned}>
    <FormRow copy={copy} />
    <span className={s.caption}>--control-height-md 30</span>
  </div>
);
