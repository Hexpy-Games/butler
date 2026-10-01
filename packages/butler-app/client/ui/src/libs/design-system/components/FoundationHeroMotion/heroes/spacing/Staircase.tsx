import type { CSSProperties, ReactNode } from "react";
import { STEPS } from "./spacingCopy";
import { count } from "./spacingCount";
import s from "./SpacingHero.module.css";

/**
 * The named scale as columns of units (rows on the tall canvas), each named
 * with its size under it; `name` prefixes the timeline's parts; `unit` sits
 * on the xs slot (the block the scale grows from).
 */
export function Staircase({ name, unit }: { name?: string; unit?: ReactNode }) {
  return (
    <div className={s.stairs}>
      {STEPS.map(([step, px], k) => (
        <span className={s.step} key={step}>
          <span className={s.stepTrack}>
            <span className={s.column} data-t={name ? `${name}-${k}` : undefined} style={{ "--n": count(px) } as CSSProperties} />
            {k === 0 ? unit : null}
          </span>
          <span className={s.stepName} data-t={name ? `${name}-n${k}` : undefined}>
            <span>{step}</span>
            <span className={s.stepPx}>{`${px}px`}</span>
          </span>
        </span>
      ))}
    </div>
  );
}
