import type { CSSProperties } from "react";
import { ComposerCard, ComposerCardEditable, ComposerCardEditor, ComposerCardExpandedBody, ComposerCardPlaceholder, ComposerCardToolbar, ComposerCardToolbarSpacer, ComposerSendButton } from "../../../../blocks/ComposerCard";
import { SurfacePanel } from "../../../../blocks/SurfacePanel";
import { Box } from "../../../Box";
import { Button } from "../../../Button";
import { IconButton } from "../../../IconButton";
import { Plus } from "../../../Icons";
import { Stack } from "../../../Stack";
import { Tag } from "../../../Tag";
import { Typo } from "../../../Typo";
import { LEVELS, LOUPE, RADII, type RadiusCopy } from "./radiusCopy";
import s from "./RadiusHero.module.css";

/** A card at the panel radius (10). */
export function ReportCard({ copy }: { copy: RadiusCopy }) {
  return (
    <Box border="hairline" padding="md" radius="panel" surface="raised">
      <Stack gap="xs">
        <Typo.Label as="span">{copy.panelTitle}</Typo.Label>
        <Typo.Caption>{copy.panelBody}</Typo.Caption>
      </Stack>
    </Box>
  );
}

/** An overlay menu at the popover radius (12). */
export function MenuCard({ copy }: { copy: RadiusCopy }) {
  return (
    <Box border="hairline" padding="xs" radius="popover" surface="overlay">
      {[copy.rename, copy.duplicate, copy.archive].map((item) => <div className={s.menuRow} key={item}><Typo.Body>{item}</Typo.Body></div>)}
    </Box>
  );
}

/** The composer (22), its send button a pill. */
export function Composer({ copy }: { copy: RadiusCopy }) {
  return (
    <span className={s.composer}>
      <ComposerCard>
        <ComposerCardExpandedBody>
          <ComposerCardEditor>
            <ComposerCardEditable><div /></ComposerCardEditable>
            <ComposerCardPlaceholder>{copy.placeholder}</ComposerCardPlaceholder>
          </ComposerCardEditor>
        </ComposerCardExpandedBody>
        <ComposerCardToolbar>
          <IconButton label={copy.more}><Plus size="md" /></IconButton>
          <ComposerCardToolbarSpacer />
          <ComposerSendButton aria-label={copy.send} mode="send" />
        </ComposerCardToolbar>
      </ComposerCard>
    </span>
  );
}

/** Finale: the corner specimen (the composer's arc under the loupe) over the ladder of five corner tiles. */
export function CornerTile() {
  return (
    <div className={s.cornerTile}>
      <span className={s.bigArc} style={{ "--r": `${22 * LOUPE * 0.5}px` } as CSSProperties} />
      <div className={s.ladder}>
        {RADII.map((step) => (
          <span className={s.rung} key={step.token}>
            <span className={s.rungTile} style={{ borderRadius: `var(${step.token})` }} />
            <span className={s.rungName}>{step.px}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

/** Finale: the component row (control, panel, popover). */
export function RowTile({ copy }: { copy: RadiusCopy }) {
  return (
    <div className={s.rowTile}>
      <span className={s.rowControls}><Button text={copy.button} /><Tag>{copy.tag}</Tag></span>
      <ReportCard copy={copy} />
      <MenuCard copy={copy} />
    </div>
  );
}

/** Finale: the three shadows front-on, each on the surface that casts it: a control's panel, a dragged card, a window. */
export function LiftTile({ copy }: { copy: RadiusCopy }) {
  const name = (k: number) => (
    <span className={s.liftName}>
      <Typo.Label as="span">{copy[LEVELS[k]!.when]}</Typo.Label>
      <span className={s.liftToken}>{LEVELS[k]!.token}</span>
    </span>
  );
  return (
    <div className={s.liftTile}>
      <SurfacePanel elevation="low">{name(0)}</SurfacePanel>
      <span className={s.dragCard} data-lifted="">
        <span className={s.dragShadow} />
        <Box border="hairline" padding="md" radius="panel" surface="raised">{name(1)}</Box>
      </span>
      <SurfacePanel elevation="high">{name(2)}</SurfacePanel>
    </div>
  );
}
