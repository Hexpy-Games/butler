import { Button } from "../../../Button";
import { Tag } from "../../../Tag";
import { type RadiusCopy } from "./radiusCopy";
import { MenuCard } from "./MenuCard";
import { ReportCard } from "./ReportCard";
import s from "./RadiusHero.module.css";

/** Finale: the component row (control, panel, popover). */
export function RowTile({ copy }: { copy: RadiusCopy }) {
  return (
    <div className={s.rowTile}>
      <span className={s.rowControls}><Button text={copy.button} /><Tag>{copy.tag}</Tag></span>
      <ReportCard copy={copy} />
      <MenuCard copy={copy} />
    </div>
  );
}
