import type { HeroLayout } from "../shared/grid";
import { Reveal as R } from "../shared/Reveal";
import { Roller } from "../shared/Roller";
import { RADII, SPECIMEN, specimenRadius, type RadiusCopy } from "./radiusCopy";
import s from "./RadiusHero.module.css";

const px = (value: number) => `${value}px`;

/** Scene 2: one corner under a loupe, on a grid of one line per real pixel, its radius made visible; the readout beside it. */
export function CornerScene({ copy, layout }: { copy: RadiusCopy; layout: HeroLayout }) {
  const spec = SPECIMEN[layout];
  const r = specimenRadius(RADII[0].px, layout);
  return (
    <div className={s.cornerStage} data-m="corner" style={{ inlineSize: px(spec.stage.w), blockSize: px(spec.stage.h) }}>
      <span className={s.pixelGrid} />
      <div className={s.cornerGroup} data-t="cg" style={{ left: px(spec.corner.x), top: px(spec.corner.y) }}>
        <span className={s.surface} data-t="cs" style={{ inlineSize: px(spec.surface.w), blockSize: px(spec.surface.h), borderRadius: px(r) }} />
        <span className={s.circle} data-t="cc" style={{ inlineSize: px(2 * r), blockSize: px(2 * r) }} />
        {/* The radius line, centred on the circle's horizontal diameter (2px thick). */}
        <span className={s.rline} data-t="cr" style={{ inlineSize: px(r), top: px(r - 1) }} />
      </div>
      <div className={s.readout} data-t="cread">
        <span className={s.loupe}><R name="loupe">{copy.loupe}</R></span>
        <Roller className={s.bigValue} id="rv" poster={0} values={RADII.map((step) => String(step.px))} />
        <span className={s.stack}>{RADII.map((step, k) => <span className={s.layer} data-t={`rt-${k}`} key={step.token}>{step.token}</span>)}</span>
        <span className={s.stack}>{RADII.map((step, k) => <span className={s.layer} data-tone="who" data-t={`rw-${k}`} key={step.who}>{step.who}</span>)}</span>
      </div>
    </div>
  );
}
