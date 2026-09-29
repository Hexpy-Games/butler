import { type SizingCopy } from "./sizingCopy";
import { Frame } from "./Frame";
import s from "./SizingHero.module.css";

/** Scene 4: the window's fixed measures, stacked like a ruler on its outer left edge. */
export function ChromeScene({ copy }: { copy: SizingCopy }) {
  return <div className={s.chromeStage} data-m="chrome"><Frame copy={copy} name="ch" /></div>;
}
