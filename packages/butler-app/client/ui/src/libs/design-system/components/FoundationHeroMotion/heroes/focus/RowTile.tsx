import { Button } from "../../../Button";
import { Input } from "../../../Input";
import { Switch } from "../../../Switch";
import type { FocusCopy } from "./focusCopy";
import s from "./FocusHero.module.css";

/** Finale: the short control row, the ring on the Switch. */
export function RowTile({ copy }: { copy: FocusCopy }) {
  return (
    <div className={s.rowTile}>
      <Button text={copy.continue} />
      <Input aria-label={copy.name} readOnly value={copy.name} />
      <span className={s.ringOn}><Switch aria-label={copy.autoSave} checked onCheckedChange={() => undefined} /></span>
    </div>
  );
}
