import { Typo } from "../../../Typo";
import { RANGES, type Mode } from "./layoutCopy";
import s from "./LayoutHero.module.css";

/** responsive.ts on a width ruler: compact to compactMax 640, medium to mediumMax 1023, expanded above. */
export function Ruler() {
  const order: Mode[] = ["compact", "medium", "expanded"];
  return (
    <div className={s.ruler}>
      {order.map((mode) => (
        <span className={s.span} key={mode}>
          <Typo.Label as="span">{mode}</Typo.Label>
          <span className={s.spanRange}>{RANGES[mode]}</span>
        </span>
      ))}
    </div>
  );
}
