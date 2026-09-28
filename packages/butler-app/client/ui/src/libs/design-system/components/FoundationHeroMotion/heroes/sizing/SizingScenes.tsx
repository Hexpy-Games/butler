import { Roller } from "../shared/Roller";
import { HIT, type SizingCopy } from "./sizingCopy";
import { Frame, Staff } from "./sizingTiles";
import { TouchBar } from "./SizingTouchBar";
import s from "./SizingHero.module.css";

/**
 * The title's touch: four rails on the word's own lines (cap height,
 * x-height, baseline, descender), drawn left to right like a staff.
 */
export const TitleRails = (
  <svg className={s.titleRails} preserveAspectRatio="none" viewBox="0 0 100 100">
    {[10.5, 28, 74, 87].map((y, k) => <line data-t={`tr-${k}`} key={y} pathLength={100} x1="0" x2="100" y1={y} y2={y} />)}
  </svg>
);

/** Scene 2: the staff; a control drops into each lane; then an off-rail 32 flashes and snaps onto md. */
export function StaffScene({ copy }: { copy: SizingCopy }) {
  return <div className={s.staffStage} data-m="staff"><Staff copy={copy} ghost name="sf" /></div>;
}

/** Scene 3 (signature): the real titlebar; the pointer's 30 targets; the cursor becomes a finger and every target grows to 44, the buttons moving apart. */
export function TouchScene({ copy }: { copy: SizingCopy }) {
  return (
    <div className={s.touchStage} data-m="touch">
      <TouchBar copy={copy} name="tc" pointer />
      <span className={s.readout} data-t="tc-read">
        <Roller className={s.bigValue} id="tcv" poster={1} values={[String(HIT.pointer), String(HIT.touch)]} />
        <span className={s.readToken}>--control-hit-target</span>
        <span className={s.modes}>
          <span className={s.mode} data-t="tc-m0">{copy.pointer}</span>
          <span className={s.mode} data-t="tc-m1">{copy.touch}</span>
        </span>
      </span>
    </div>
  );
}

/** Scene 4: the window's fixed measures, stacked like a ruler on its outer left edge. */
export function ChromeScene({ copy }: { copy: SizingCopy }) {
  return <div className={s.chromeStage} data-m="chrome"><Frame copy={copy} name="ch" /></div>;
}
