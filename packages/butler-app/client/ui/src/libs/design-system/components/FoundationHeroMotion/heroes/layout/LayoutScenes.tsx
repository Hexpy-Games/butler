import { Reveal as R } from "../shared/Reveal";
import { Roller } from "../shared/Roller";
import { MODES, WIDTHS, tokenValue, type LayoutCopy } from "./layoutCopy";
import { Shell } from "./layoutTiles";
import s from "./LayoutHero.module.css";

/** The title's touch: a thin page frame around the word, its max-width guides drawing down each side. */
export const TitleFrame = (
  <svg className={s.titleFrame} preserveAspectRatio="none" viewBox="0 0 100 100">
    <rect data-t="tf-r" height="100" pathLength={100} width="100" x="0" y="0" />
    <line data-t="tf-l" pathLength={100} x1="6" x2="6" y1="-12" y2="112" />
    <line data-t="tf-g" pathLength={100} x1="94" x2="94" y1="-12" y2="112" />
  </svg>
);

/**
 * The shell scene: an empty page frame whose parts draw with their measures
 * on its rim; the real shell fills it; a handle drags it 1280 → 1023 → 640 →
 * 375, the shell relaying out at each detent (mode from responsive.ts); at
 * 375 the sidebar is a drawer and the device supplies the insets.
 */
export function ShellScene({ copy }: { copy: LayoutCopy }) {
  const modeOf = WIDTHS.map((w) => MODES.indexOf(w.mode));
  return (
    <div className={s.stage} data-m="shell">
      <div className={s.readout} data-t="ro">
        <span className={s.readWidth}><Roller id="rw" poster={0} values={WIDTHS.map((w) => String(w.px))} />px</span>
        <span className={s.readMode}><Roller id="rm" poster={0} values={modeOf.map((m) => MODES[m]!)} /></span>
        <span className={s.source}>{copy.source}</span>
      </div>
      <div className={s.frameBox}>
        <div className={s.window} data-m="win" data-t="win">
          {WIDTHS.map((_, k) => <div className={s.layer} data-t={`l${k}`} key={k}><Shell copy={copy} k={k} name={`l${k}`} /></div>)}
        </div>
        <span className={s.handle} data-t="handle" />
        <span className={s.dim} data-part="bar" data-t="dm-bar"><span className={s.dimLabel}><R name="dl-bar">{`--titlebar-height ${tokenValue("--titlebar-height")}`}</R></span></span>
        <span className={s.dim} data-part="side" data-t="dm-side"><span className={s.dimLabel}><R name="dl-side">{`--sidebar-width ${tokenValue("--sidebar-width")}`}</R></span></span>
        <span className={s.dim} data-part="gutter" data-t="dm-gutter"><span className={s.dimLabel}><R name="dl-gutter">--page-container-gutter</R></span></span>
        <span className={s.insetLabel} data-t="il">{`--safe-area-* · ${copy.device}`}</span>
      </div>
    </div>
  );
}
