import { Button } from "../../../Button";
import { Input } from "../../../Input";
import { Switch } from "../../../Switch";
import type { FocusCopy } from "./focusCopy";
import { Range } from "./FocusScenes";
import { CompactShell, WideShell } from "./FocusShell";
import s from "./FocusHero.module.css";

/** Finale: the app with the ring resting on Send (wide window, or the compact screen on the tall canvas). */
export function ShellTile({ copy }: { copy: FocusCopy }) {
  return (
    <div className={`${s.routes} ${s.tileWindow}`} data-still="">
      <div className={s.routeStage} data-layout-only="wide"><WideShell copy={copy} /></div>
      <div className={s.routeStage} data-layout-only="tall"><CompactShell copy={copy} /></div>
    </div>
  );
}

/** Finale: the range picker is one stop; the ring on its selected item. */
export function GroupTile({ copy }: { copy: FocusCopy }) {
  return (
    <div className={s.tabsTile}>
      <span className={s.ringItem}><Range copy={copy} value="week" /></span>
      <span className={s.caption}>{copy.roving}</span>
    </div>
  );
}

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

/** Finale: the ring close-up. */
export function CloseTile({ copy }: { copy: FocusCopy }) {
  return (
    <span className={s.closeTarget} data-still="">
      <span className={s.ringOn}><Button text={copy.continue} /></span>
      <span className={s.note} data-place="top">--focus-ring-width 2</span>
      <span className={s.note} data-place="bottom"><span className={s.swatch} />--focus-ring-color</span>
    </span>
  );
}
