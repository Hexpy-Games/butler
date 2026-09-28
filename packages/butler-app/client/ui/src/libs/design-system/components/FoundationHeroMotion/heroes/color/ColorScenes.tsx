import { useEffect, useState, type CSSProperties } from "react";
import { Reveal as R } from "../shared/Reveal";
import { SWATCHES } from "./colorCopy";
import s from "./ColorHero.module.css";

/** A token name that may break after its family prefix (--color-), so it fits under its sticker. */
function breakable(token: string) {
  const cut = token.startsWith("--color-") ? 8 : 0;
  return cut ? <>{token.slice(0, cut)}<wbr />{token.slice(cut)}</> : token;
}

/** The theme the page is not in: the wipe turns the whole frame to it (and back). */
function useOtherTheme(): "light" | "dark" {
  const read = (): "light" | "dark" => (typeof document !== "undefined" && document.body.classList.contains("theme-dark") ? "light" : "dark");
  const [other, setOther] = useState(read);
  useEffect(() => {
    if (typeof MutationObserver !== "function") return undefined;
    const observer = new MutationObserver(() => setOther(read()));
    observer.observe(document.body, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);
  return other;
}

/**
 * A sticker: a disc in two halves. It comes down with its right half curled
 * up (turned about the centre line, shaded at the fold) and presses flat from
 * the left edge to the right (`st-<k>`, `st-<k>-r`, `st-<k>-c`).
 */
function Sticker({ k, token }: { k: number; token: string }) {
  return (
    <span className={s.sticker} data-t={`st-${k}`} style={{ "--c": `var(${token})` } as CSSProperties}>
      <span className={s.half} data-half="l"><span className={s.disc} /></span>
      <span className={s.half} data-half="r" data-t={`st-${k}-r`}><span className={s.disc} /><span className={s.curl} data-t={`st-${k}-c`} /></span>
    </span>
  );
}

/** The swatch stickers with their token names, straight on the page. */
function SwatchGrid() {
  return (
    <div className={s.grid}>
      {SWATCHES.map((token, k) => (
        <div className={s.cell} key={token}>
          <Sticker k={k} token={token} />
          <span className={s.name}><R name={`sn-${k}`}>{breakable(token)}</R></span>
        </div>
      ))}
    </div>
  );
}

/**
 * The token field: role stickers straight on the page. Over it, the whole
 * frame in the other theme (page, stickers and names) waits behind a window
 * that a thin line sweeps across and back: before, after, before.
 */
export function ColorField() {
  const other = useOtherTheme();
  return (
    <div className={s.field} data-m="field">
      <SwatchGrid />
      <div className={s.wipe} data-t="wipe">
        <div className={s.wipeIn} data-t="wipe-in">
          <div className={`${s.other} theme-${other}`}><div className={s.otherField}><SwatchGrid /></div></div>
        </div>
        <span className={s.wipeLine} data-edge="r" data-t="wipe-line" />
        <span className={s.wipeLine} data-edge="l" data-t="wipe-back" />
      </div>
    </div>
  );
}
