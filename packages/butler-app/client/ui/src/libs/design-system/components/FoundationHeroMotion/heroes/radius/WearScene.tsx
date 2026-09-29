import { Button } from "../../../Button";
import { Tag } from "../../../Tag";
import { Worn } from "./radiusArc";
import { type RadiusCopy } from "./radiusCopy";
import { Composer } from "./Composer";
import { MenuCard } from "./MenuCard";
import { ReportCard } from "./ReportCard";
import s from "./RadiusHero.module.css";

/** Scene 3: who wears which corner: real components top-aligned under one line of values; an arc draws itself on each real corner in turn. */
export function WearScene({ copy }: { copy: RadiusCopy }) {
  return (
    <div className={s.wearStage} data-m="wear">
      <span className={s.wornGroup} data-pair="">
        <Worn n="0"><Button text={copy.button} /></Worn>
        <Worn n="1" value="999"><Tag>{copy.tag}</Tag></Worn>
      </span>
      <span className={s.wornGroup}><Worn n="2"><ReportCard copy={copy} /></Worn></span>
      <span className={s.wornGroup}><Worn n="3"><MenuCard copy={copy} /></Worn></span>
      <span className={s.wornGroup}><Worn n="4"><Composer copy={copy} /></Worn></span>
    </div>
  );
}
