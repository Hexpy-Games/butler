import type { ReactNode } from "react";
import { SurfacePanel } from "../../../../blocks/SurfacePanel";
import { Box } from "../../../Box";
import { Button } from "../../../Button";
import { SegmentedControl } from "../../../SegmentedControl";
import { Stack } from "../../../Stack";
import { Tag } from "../../../Tag";
import { Typo } from "../../../Typo";
import type { HeroLayout } from "../shared/grid";
import { Reveal as R } from "../shared/Reveal";
import { Roller } from "../shared/Roller";
import { Worn } from "./radiusArc";
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

/** Scene 3: who wears which corner: real components top-aligned under one line of values; an arc draws itself on each real corner in turn. */
export function WearScene({ copy }: { copy: RadiusCopy }) {
  return (
    <div className={s.wearStage} data-m="wear">
      <span className={s.wornGroup} data-pair="">
        <Worn n="0"><Button text={copy.button} /></Worn>
        <Worn n="1" value="999"><Tag>{copy.tag}</Tag></Worn>
      </span>
      <span className={s.wornGroup}><Worn n="2"><ReportCard copy={copy} /></Worn></span>
      <span className={s.wornGroup}><Worn n="3"><MenuCard copy={copy} /></Worn></span>
      <span className={s.wornGroup}><Worn n="4"><Composer copy={copy} /></Worn></span>
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

/** An elevation scene: the moment one shadow is cast, and under it when that shadow is used and its token. */
function Level({ k, copy, children }: { k: number; copy: RadiusCopy; children: ReactNode }) {
  const level = LEVELS[k]!;
  return (
    <div className={s.level} data-m={`lv-${k}`}>
      {children}
      <span className={s.levelNote}>
        <span className={s.levelWhen}><R name={`lw-${k}`}>{copy[level.when]}</R></span>
        <span className={s.levelToken}><R name={`lt-${k}`}>{level.token}</R></span>
      </span>
    </div>
  );
}

const cardBody = (title: string, body: string) => (
  <Box border="hairline" padding="md" radius="panel" surface="raised">
    <Stack gap="xs"><Typo.Label as="span">{title}</Typo.Label><Typo.Caption>{body}</Typo.Caption></Stack>
  </Box>
);

/** Scene 5: a control you press: the chosen segment rises off its track on --shadow-control (the real SegmentedControl, before and after). */
export function PressScene({ copy }: { copy: RadiusCopy }) {
  const options = [{ value: "day", label: copy.day }, { value: "week", label: copy.week }, { value: "month", label: copy.month }];
  const noop = () => undefined;
  return (
    <Level copy={copy} k={0}>
      <span className={s.swap}>
        <span data-t="px-0"><SegmentedControl ariaLabel={copy.period} onValueChange={noop} options={options} value="day" /></span>
        <span data-t="px-1"><SegmentedControl ariaLabel={copy.period} onValueChange={noop} options={options} value="week" /></span>
      </span>
    </Level>
  );
}

/** Scene 6: a card you drag: it lifts (scale and --shadow-drag-lift, as SortableCardList does), moves down a slot and settles. */
export function DragScene({ copy }: { copy: RadiusCopy }) {
  return (
    <Level copy={copy} k={1}>
      <span className={s.cards}>
        {copy.cards.map(([title, body], k) => (
          <span className={s.dragCard} data-lifted={k === 0 ? "" : undefined} data-m={`dc-${k}`} data-t={`dc-${k}`} key={title}>
            {k === 0 ? <span className={s.dragShadow} data-t="dshadow" /> : null}
            {cardBody(title, body)}
          </span>
        ))}
      </span>
    </Level>
  );
}

/** Scene 7: a window over content: a panel at elevation high opens over the page's cards on --shadow-window. */
export function OverScene({ copy }: { copy: RadiusCopy }) {
  return (
    <Level copy={copy} k={2}>
      <span className={s.cards}>
        {copy.cards.map(([title, body]) => <span key={title}>{cardBody(title, body)}</span>)}
        <span className={s.window} data-t="win">
          <SurfacePanel elevation="high">
            <Stack gap="md">
              <Stack gap="xs"><Typo.Label as="span">{copy.shareTitle}</Typo.Label><Typo.Caption>{copy.shareBody}</Typo.Caption></Stack>
              <Stack align="row" gap="sm" justify="end"><Button size="sm" text={copy.cancel} variant="outline" /><Button size="sm" text={copy.share} /></Stack>
            </Stack>
          </SurfacePanel>
        </span>
      </span>
    </Level>
  );
}
