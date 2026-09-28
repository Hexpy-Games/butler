import type { CSSProperties, ReactNode } from "react";
import { SurfacePanel } from "../../../../blocks/SurfacePanel";
import { Box } from "../../../Box";
import { Button } from "../../../Button";
import { Tag } from "../../../Tag";
import { Typo } from "../../../Typo";
import type { HeroLayout } from "../shared/grid";
import { Mark } from "../shared/Mark";
import { Reveal as R } from "../shared/Reveal";
import { Roller } from "../shared/Roller";
import { LEVELS, RADII, SPECIMEN, specimenRadius, type RadiusCopy } from "./radiusCopy";
import { Composer, MenuCard, ReportCard } from "./radiusTiles";
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
        <span className={s.rline} data-t="cr" style={{ inlineSize: px(r), top: px(r) }} />
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

/** A component in the row, its corner marked for the ghost arc and its value set above it. */
function Worn({ n, value, children }: { n: string; value: string; children: ReactNode }) {
  return (
    <span className={s.worn}>
      <span className={s.wornValue} data-t={`wv-${n}`}>{value}</span>
      <Mark n={n}>{children}</Mark>
    </span>
  );
}

/** Scene 3: who wears which corner: real components on one line, a ghost arc landing on each top-left corner. */
export function WearScene({ copy }: { copy: RadiusCopy }) {
  return (
    <div className={s.wearStage} data-m="wear" data-mark-scope="wear">
      <Worn n="w0" value="8"><Button text={copy.button} /></Worn>
      <Worn n="w1" value="10"><ReportCard copy={copy} /></Worn>
      <Worn n="w2" value="12"><MenuCard copy={copy} /></Worn>
      <Worn n="w3" value="22"><Composer copy={copy} /></Worn>
      <Worn n="w4" value="999"><Tag>{copy.tag}</Tag></Worn>
      <span className={s.ghost} data-t="ghost" />
    </div>
  );
}

/** Scene 4: the only nested pair, their arcs concentric; a wrong inner corner flashes and morphs back. */
export function NestScene({ copy }: { copy: RadiusCopy }) {
  return (
    <div className={s.nestStage}>
      <div className={s.nestCard} data-m="nest">
        <Box border="hairline" padding="lg" radius="panel" surface="raised">
          <span className={s.nestButton}>
            <Button text={copy.button} />
            <span className={s.wrong} data-t="nw" />
            <span className={s.arc} data-size="inner" data-t="na-i" />
            <span className={s.nestNote} data-place="inner" data-t="nn-i">--radius-control 8</span>
          </span>
        </Box>
        <span className={s.arc} data-size="outer" data-t="na-o" />
        <span className={s.padMark} data-t="np" />
        <span className={s.nestNote} data-place="outer" data-t="nn-o">--radius-panel 10</span>
      </div>
    </div>
  );
}

/** Scene 5: a floor in quarter view; three real surfaces lie on it and rise in turn, their floor shadows widening and softening. */
export function FloorScene({ copy }: { copy: RadiusCopy }) {
  const items = [<Button key="b" text={copy.button} />, <ReportCard copy={copy} key="c" />, <SurfacePanel elevation="high" key="w"><Typo.Label as="span">{copy.panelTitle}</Typo.Label></SurfacePanel>];
  return (
    <div className={s.floorStage} data-m="floor">
      <span className={s.floor} />
      {LEVELS.map((level, k) => (
        <div className={s.spot} key={level.token} style={{ "--k": k } as CSSProperties}>
          <span className={s.floorShadow} data-level={level.elevation} data-t={`fs-${k}`} />
          <span className={s.post}><span className={s.postIn} data-t={`fp-${k}`} style={{ blockSize: px(level.rise) }} /></span>
          <div className={s.lift} data-t={`fl-${k}`}>{items[k]}</div>
          <span className={s.floorLabel} data-t={`fn-${k}`}>{`${copy[level.elevation]} · ${level.token}`}</span>
        </div>
      ))}
    </div>
  );
}
