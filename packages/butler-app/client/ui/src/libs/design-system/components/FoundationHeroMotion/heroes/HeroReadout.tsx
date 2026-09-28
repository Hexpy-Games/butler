import type { CSSProperties } from "react";
import s from "../FoundationHeroMotion.module.css";

export type ReadoutSlots = 4 | 5 | 6 | 9 | 10 | 14;

/**
 * The live caption of a hero: which token (and value) the graphic shows right
 * now. One entry per slot of the hero's cycle; entries cut (never cross-fade)
 * a tenth into their slot, as the graphic arrives. Token names and numbers
 * only, so nothing here translates.
 */
export function HeroReadout({ items, slots, poster = 0 }: { items: string[]; slots: ReadoutSlots; /** Entry the still poster shows. */ poster?: number }) {
  return (
    <span className={s.readout}>
      {items.map((item, k) => (
        <span className={s.readoutItem} data-slots={slots} data-poster={k === poster ? "" : undefined} key={k}
          style={{ "--k": k, "--hero-slots": slots } as CSSProperties}>
          {item}
        </span>
      ))}
    </span>
  );
}
