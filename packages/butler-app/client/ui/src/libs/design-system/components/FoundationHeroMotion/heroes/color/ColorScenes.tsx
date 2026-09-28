import type { CSSProperties } from "react";
import { Reveal as R } from "../shared/Reveal";
import { SWATCHES, type ColorCopy } from "./colorCopy";
import s from "./ColorHero.module.css";

/** A token name that may break after its family prefix (--color-), so it fits under its sticker. */
function breakable(token: string) {
  const cut = token.startsWith("--color-") ? 8 : 0;
  return cut ? <>{token.slice(0, cut)}<wbr />{token.slice(cut)}</> : token;
}

/**
 * Scene 1: the chapter title large on the left, the color strategy, tone and
 * manner, and intent on the right (below on the tall canvas), set above the
 * poster.
 */
export function ColorIntro({ copy }: { copy: ColorCopy }) {
  return (
    <div className={s.intro} data-m="intro">
      <div className={s.introTitle} data-t="i-title"><R name="i-t">{copy.title}</R></div>
      <div className={s.introLead}>
        {copy.lead.map(([key, text], n) => (
          <p className={s.leadLine} data-t={`i-p${n}`} key={key}>
            <span className={s.leadKey}><R name={`i-k${n}`}>{key}</R></span>
            <span className={s.leadText}><R name={`i-l${n}`}>{text}</R></span>
          </p>
        ))}
      </div>
    </div>
  );
}

/** The swatch stickers with their token names, in one theme scope. */
function SwatchGrid() {
  return (
    <div className={s.grid}>
      {SWATCHES.map((token, k) => (
        <div className={s.cell} key={token}>
          <span className={s.sticker} data-t={`st-${k}`} style={{ "--c": `var(${token})` } as CSSProperties} />
          <span className={s.name}><R name={`sn-${k}`}>{breakable(token)}</R></span>
        </div>
      ))}
    </div>
  );
}

/**
 * The token field: the role stickers on a light plate, with the same field
 * in the dark theme over it, shown through a window that a thin line sweeps
 * left to right (before and after). The poster rests on the split.
 */
export function ColorField() {
  return (
    <div className={s.field} data-m="field">
      <div className={`${s.plate} theme-light`}><SwatchGrid /></div>
      <div className={s.wipe} data-t="wipe">
        <div className={s.wipeIn} data-t="wipe-in"><div className={`${s.plate} theme-dark`}><SwatchGrid /></div></div>
        <span className={s.wipeLine} data-t="wipe-line" />
      </div>
    </div>
  );
}
