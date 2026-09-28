import type { CSSProperties, ReactNode } from "react";
import { Sparkles } from "../../../Icons";
import { Typo } from "../../../Typo";
import { Reveal as R } from "../shared/Reveal";
import { SIZES, type IconCopy } from "./iconCopy";
import s from "./IconHero.module.css";

/** Every line of the 24-unit keyline grid, as one path drawn along its length. */
const GRID_PATH = Array.from({ length: 25 }, (_, k) => `M${k} 0V24M0 ${k}H24`).join("");
export const GRID_LENGTH = 25 * 48;
/** Stroke paths a glyph may have (drawn one after another). */
export const GLYPH_PATHS = 4;

/**
 * Scene 2, left of the poster: the glyph on its 24px keyline grid, the
 * padding box and the keyline circle, drawn stroke by stroke at 8×.
 */
export function IconLab({ copy }: { copy: IconCopy }) {
  return (
    <div className={s.lab} data-t="lab">
      <div className={s.labStage} data-m="lab">
        <div className={s.keyBox}>
          <svg className={s.keySvg} viewBox="0 0 24 24">
            <path className={s.keyGrid} d={GRID_PATH} data-t="k-grid" style={{ "--dash": `${GRID_LENGTH}px` } as CSSProperties} />
            <path className={s.keyLine} d="M2 2H22V22H2Z" data-t="k-pad" style={{ "--dash": "80px" } as CSSProperties} />
            <circle className={s.keyLine} cx="12" cy="12" data-t="k-circle" r="10" style={{ "--dash": "63px" } as CSSProperties} />
          </svg>
          <span className={s.keyGlyph} data-t="k-glyph"><Sparkles size={192} /></span>
        </div>
        <div className={s.keyNotes}>
          <span><R name="k-n0">{copy.grid}</R></span>
          <span><R name="k-n1">{copy.padding}</R></span>
          <span><R name="k-n2">{copy.stroke}</R></span>
        </div>
      </div>
    </div>
  );
}

function role(name: (typeof SIZES)[number]["role"], text: ReactNode) {
  switch (name) {
    case "caption": return <Typo.Caption>{text}</Typo.Caption>;
    case "body": return <Typo.Body>{text}</Typo.Body>;
    case "h4": return <Typo.H4 as="span">{text}</Typo.H4>;
    case "h3": return <Typo.H3 as="span">{text}</Typo.H3>;
    case "h2": return <Typo.H2 as="span">{text}</Typo.H2>;
  }
}

/**
 * The token field: one glyph at the six sizes on its size box, each beside
 * the type it pairs with on one centre line; three color layers (muted,
 * primary, accent) the glyphs recolor through.
 */
export function IconField({ copy }: { copy: IconCopy }) {
  return (
    <div className={s.field} data-m="field">
      <span className={s.mode}>
        {["--icon-muted", "--text-primary", "--accent"].map((token, k) => <span className={s.modeLayer} data-t={`im-${k}`} key={token}>{token}</span>)}
      </span>
      {SIZES.map((size, k) => (
        <div className={s.row} key={size.name}>
          <span className={s.token}><R name={`il-n${k}`}>{`--icon-size-${size.name}`}</R></span>
          <span className={s.pair}>
            <span className={s.center} data-t={`il-c${k}`} />
            <span className={s.iconBox} data-t={`il-b${k}`} style={{ "--s": `var(--icon-size-${size.name})` } as CSSProperties}>
              {(["muted", "primary", "accent"] as const).map((tone) => (
                <span className={s.tone} data-t={`il-${tone}-${k}`} data-tone={tone} key={tone}><Sparkles size={size.name} /></span>
              ))}
            </span>
            <span className={s.text} data-t={`il-t${k}`}>{role(size.role, <R name={`il-w${k}`}>{copy.pairs[k]}</R>)}</span>
          </span>
          <span className={s.value}><R name={`il-v${k}`}>{String(size.px)}</R></span>
        </div>
      ))}
    </div>
  );
}
