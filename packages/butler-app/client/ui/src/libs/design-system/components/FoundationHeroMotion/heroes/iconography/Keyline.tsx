import { type CSSProperties } from "react";
import { Settings } from "../../../Icons";
import { Reveal as R } from "../shared/Reveal";
import { type IconCopy } from "./iconCopy";
import { GRID_LENGTH } from "./iconParts";
import s from "./IconHero.module.css";

/** Every line of the 24-unit keyline grid, as one path drawn along its length. */
const GRID_PATH = Array.from({ length: 25 }, (_, k) => `M${k} 0V24M0 ${k}H24`).join("");

/**
 * The gear on its 24px keyline grid at 8×: the grid, the 2px padding box and
 * the keyline circle; its three notes on three sides (top, right, bottom),
 * each at its own edge so none meets another.
 */
export function Keyline({ copy }: { copy: IconCopy }) {
  return (
    <div className={s.keyline}>
      <span className={s.keyNote} data-side="top"><R name="kl-n0">{copy.grid}</R></span>
      <div className={s.keyBox}>
        <svg className={s.keySvg} viewBox="0 0 24 24">
          <path className={s.keyGrid} d={GRID_PATH} data-t="kl-grid" style={{ "--dash": `${GRID_LENGTH}px` } as CSSProperties} />
          <path className={s.keyLine} d="M2 2H22V22H2Z" data-t="kl-pad" style={{ "--dash": "80px" } as CSSProperties} />
          <circle className={s.keyLine} cx="12" cy="12" data-t="kl-circle" r="10" style={{ "--dash": "63px" } as CSSProperties} />
        </svg>
        <span className={s.keyGlyph} data-t="kl-glyph"><Settings size={192} /></span>
      </div>
      <span className={s.keyNote} data-side="right"><R name="kl-n1">{copy.padding}</R></span>
      <span className={s.keyNote} data-side="bottom"><R name="kl-n2">{copy.stroke}</R></span>
    </div>
  );
}
