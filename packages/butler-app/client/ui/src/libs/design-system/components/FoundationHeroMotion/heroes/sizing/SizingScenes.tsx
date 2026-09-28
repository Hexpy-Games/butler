import { Roller } from "../shared/Roller";
import { HIT, type SizingCopy } from "./sizingCopy";
import { Frame, Halos, Staff, Strip } from "./sizingTiles";
import s from "./SizingHero.module.css";

/** The title's touch: four rails draw under "Sizing", left to right, like a staff. */
export const TitleRails = (
  <svg className={s.titleRails} preserveAspectRatio="none" viewBox="0 0 100 100">
    {[18, 44, 72, 92].map((y, k) => <line data-t={`tr-${k}`} key={y} pathLength={100} x1="0" x2="100" y1={y} y2={y} />)}
  </svg>
);

/** Scene 2: the staff; a control drops into each lane; then an off-rail 32 flashes and snaps onto md. */
export function StaffScene({ copy }: { copy: SizingCopy }) {
  return <div className={s.staffStage} data-m="staff"><Staff copy={copy} ghost name="sf" /></div>;
}

/** Scene 3 (signature): a titlebar's 24px icon buttons; the pointer's 30 target blooms; the cursor becomes a finger and every target grows to 44. */
export function TouchScene({ copy }: { copy: SizingCopy }) {
  return (
    <div className={s.touchStage} data-m="touch">
      <Strip copy={copy}><Halos copy={copy} name="tc" pointer /></Strip>
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

/** Scene 4: the app frame's fixed measures, stacked like a ruler on its outer left edge. */
export function ChromeScene({ copy }: { copy: SizingCopy }) {
  return <div className={s.chromeStage} data-m="chrome"><Frame copy={copy} name="ch" /></div>;
}
