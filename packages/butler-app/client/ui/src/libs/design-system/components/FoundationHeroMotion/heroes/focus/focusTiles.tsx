import { Button } from "../../../Button";
import { Input } from "../../../Input";
import { SegmentedControl } from "../../../SegmentedControl";
import { Switch } from "../../../Switch";
import { Tabs, TabsList, TabsTrigger } from "../../../Tabs";
import type { FocusCopy } from "./focusCopy";
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

/** Finale: Tabs as one stop, the ring on the active tab. */
export function TabsTile({ copy }: { copy: FocusCopy }) {
  return (
    <div className={s.tabsTile}>
      <span className={s.ringTab}>
        <Tabs value="summary">
          <TabsList aria-label={copy.summary} variant="line">
            <TabsTrigger value="summary">{copy.summary}</TabsTrigger>
            <TabsTrigger value="files">{copy.filesTab}</TabsTrigger>
            <TabsTrigger value="activity">{copy.activity}</TabsTrigger>
          </TabsList>
        </Tabs>
      </span>
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
      <SegmentedControl ariaLabel={copy.week} onValueChange={() => undefined} value="week" options={[{ value: "week", label: copy.week }, { value: "month", label: copy.month }]} />
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
