import { type IconCopy } from "./iconCopy";
import { Keyline } from "./Keyline";
import s from "./IconHero.module.css";

/** Scene 2: the gear on its keyline grid, drawn stroke by stroke; three notes on three sides. */
export function GlyphScene({ copy }: { copy: IconCopy }) {
  return <div className={s.glyphStage} data-m="glyph"><Keyline copy={copy} /></div>;
}
