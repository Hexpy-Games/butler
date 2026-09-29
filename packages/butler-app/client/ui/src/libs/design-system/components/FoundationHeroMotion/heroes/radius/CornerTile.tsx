import type { CSSProperties } from "react";
import { LOUPE, RADII } from "./radiusCopy";
import s from "./RadiusHero.module.css";

/** Finale: the corner specimen (the composer's arc under the loupe) over the ladder of five corner tiles. */
export function CornerTile() {
  return (
    <div className={s.cornerTile}>
      <span className={s.bigArc} style={{ "--r": `${22 * LOUPE * 0.5}px` } as CSSProperties} />
      <div className={s.ladder}>
        {RADII.map((step) => (
          <span className={s.rung} key={step.token}>
            <span className={s.rungTile} style={{ borderRadius: `var(${step.token})` }} />
            <span className={s.rungName}>{step.px}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
