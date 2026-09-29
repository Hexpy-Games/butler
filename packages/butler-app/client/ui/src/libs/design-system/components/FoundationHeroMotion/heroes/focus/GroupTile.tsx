import type { FocusCopy } from "./focusCopy";
import { Range } from "./Range";
import s from "./FocusHero.module.css";

/** Finale: the range picker is one stop; the ring on its selected item. */
export function GroupTile({ copy }: { copy: FocusCopy }) {
  return (
    <div className={s.tabsTile}>
      <span className={s.ringItem}><Range copy={copy} value="week" /></span>
      <span className={s.caption}>{copy.roving}</span>
    </div>
  );
}
