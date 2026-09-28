import type { FoundationHeroLang } from "../FoundationHeroMotion";
import { CompositionScene } from "./typography/CompositionScene";
import { ScaleScene } from "./typography/ScaleScene";
import { TypefaceScene } from "./typography/TypefaceScene";
import t from "./typography/TypographyHero.module.css";

/**
 * 02 Typography: how Butler's type works, in three scenes on one loop: the
 * typeface and its weight axis, the role scale with live size/leading, and a
 * paragraph resolving into hierarchy with its leading and tabular numerals.
 * The still poster is the composed final frame of the last scene.
 */
export function TypographyHero({ lang }: { lang: FoundationHeroLang }) {
  return (
    <div className={t.board}>
      <TypefaceScene />
      <ScaleScene />
      <CompositionScene lang={lang} />
    </div>
  );
}
