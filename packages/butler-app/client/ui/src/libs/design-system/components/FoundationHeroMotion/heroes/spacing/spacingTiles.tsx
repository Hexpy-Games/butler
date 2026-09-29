import type { CSSProperties, ReactNode } from "react";
import { SettingsField } from "../../../../blocks/SettingsField";
import { SettingsSection } from "../../../../blocks/SettingsSection";
import { Button } from "../../../Button";
import { ButtonContainer } from "../../../ButtonContainer";
import { Card } from "../../../Card";
import { Stack } from "../../../Stack";
import { Switch } from "../../../Switch";
import { Typo } from "../../../Typo";
import { Reveal as R } from "../shared/Reveal";
import { COMPACT_PAD, GAPS, STEPS, UNIT, type GapId, type SpacingCopy } from "./spacingCopy";
import s from "./SpacingHero.module.css";

/** 4px units a space holds. */
export const count = (px: number) => px / UNIT;

/** A space's count: `20 = 5×4`. */
export const sum = (px: number) => `${px} = ${count(px)}×${UNIT}`;

/** Units of a column, bottom first (named `${name}-u${j}` for the timeline). */
function Units({ n, name, row = false }: { n: number; name?: string; row?: boolean }) {
  return (
    <span className={s.units} data-row={row ? "" : undefined}>
      {Array.from({ length: n }, (_, j) => <span className={s.u} data-t={name ? `${name}-u${j}` : undefined} key={j} />)}
    </span>
  );
}

/**
 * A measured space: its blue highlight (`${name}-f`), sized by the live token
 * and anchored by CSS to what it sits against, and right of it one column of
 * 4px units exactly as tall as the space, with its label beside it.
 */
export function Gap({ id, n, name, label }: { id: GapId; n: number; name?: string; label?: ReactNode }) {
  return (
    <span className={s.gap} data-gap={id}>
      <span className={s.fill} data-t={name ? `${name}-f` : undefined} />
      <span className={s.col}>
        <Units n={n} name={name} />
        {label ? <span className={s.gapLabel}>{label}</span> : null}
      </span>
    </span>
  );
}

/** A gap's label: its count, then (wide canvas only) its token or a note; revealed as `reveal`. */
export function GapLabel({ px, note, reveal }: { px: number; note?: string; reveal: string }) {
  return (
    <R name={reveal}>
      <span className={s.sum}>{sum(px)}</span>
      {note ? <span className={s.note}>{` · ${note}`}</span> : null}
    </R>
  );
}

function field(label: string, hint: string, on: boolean) {
  return <SettingsField control={<Switch aria-label={label} checked={on} onCheckedChange={() => undefined} />} description={hint} label={label} />;
}

/**
 * A real settings section (two fields) with its spaces measured: the header
 * gap and top inset above the first field, the field gap and the bottom inset
 * around the second. `name` prefixes the timeline's parts; `density` pins the
 * card inset (compact tightens only the inset); `labels` names each space
 * (`short`: the count only); `only` limits the columns to some spaces.
 */
export function Section({ copy, name, density = "comfortable", labels, only }: {
  copy: SpacingCopy; name?: string; density?: "comfortable" | "compact"; labels?: "full" | "short"; only?: GapId[];
}) {
  const px = (id: GapId) => (density === "compact" && (id === "pt" || id === "pb") ? COMPACT_PAD : GAPS[id].px);
  const gap = (id: GapId) => {
    const part = name ? `${name}-${id}` : undefined;
    const counted = !only || only.includes(id);
    const label = labels && part && counted ? <GapLabel note={labels === "full" ? GAPS[id].token : undefined} px={px(id)} reveal={`${part}-l`} /> : undefined;
    return <Gap id={id} label={label} n={counted ? count(px(id)) : 0} name={part} />;
  };
  return (
    <div className={s.section} data-density={density}>
      <SettingsSection id={`space-hero-${name ?? "tile"}`} kind="form" title={copy.general}>
        <div className={s.field}>{gap("hg")}{gap("pt")}{field(copy.sync, copy.syncHint, true)}</div>
        <div className={s.field}>{gap("fg")}{field(copy.sounds, copy.soundsHint, false)}{gap("pb")}</div>
      </SettingsSection>
    </div>
  );
}

/**
 * The named scale as columns of units (rows on the tall canvas), each named
 * with its size under it; `name` prefixes the timeline's parts; `unit` sits
 * on the xs slot (the block the scale grows from).
 */
export function Staircase({ name, unit }: { name?: string; unit?: ReactNode }) {
  return (
    <div className={s.stairs}>
      {STEPS.map(([step, px], k) => (
        <span className={s.step} key={step}>
          <span className={s.stepTrack}>
            <span className={s.column} data-t={name ? `${name}-${k}` : undefined} style={{ "--n": count(px) } as CSSProperties} />
            {k === 0 ? unit : null}
          </span>
          <span className={s.stepName} data-t={name ? `${name}-n${k}` : undefined}>
            <span>{step}</span>
            <span className={s.stepPx}>{`${px}px`}</span>
          </span>
        </span>
      ))}
    </div>
  );
}

/** Two buttons; the gap between them highlighted, its two units under it. */
export function Inline({ copy }: { copy: SpacingCopy }) {
  return (
    <ButtonContainer size="default">
      <Button text={copy.cancel} variant="outline" />
      <span className={s.after}>
        <span className={s.inlineGap}>
          <span className={s.fill} />
          <Units n={count(8)} row />
        </span>
        <Button text={copy.save} />
      </span>
    </ButtonContainer>
  );
}

/** A card, its inset highlighted, the top inset's units beside it. */
export function InsetCard({ copy }: { copy: SpacingCopy }) {
  return (
    <span className={s.insetCard}>
      <Card padding="md">
        <Stack gap="xs">
          <Typo.Label as="span">{copy.cardTitle}</Typo.Label>
          <Typo.Body tone="secondary">{copy.cardBody}</Typo.Body>
        </Stack>
      </Card>
      <span className={s.inset} />
      <span className={s.insetUnits}><Units n={count(12)} /></span>
    </span>
  );
}

/** Finale tiles. */
export const StairsTile = () => <div className={s.stairsTile}><Staircase /></div>;
export const SectionTile = ({ copy }: { copy: SpacingCopy }) => <div className={s.sectionTile}><Section copy={copy} /></div>;
export const InlineTile = ({ copy }: { copy: SpacingCopy }) => (
  <div className={s.inlineTile}>
    <Inline copy={copy} />
    <span className={s.caption}>{`--space-sm · ${sum(8)}`}</span>
  </div>
);
export const CardTile = ({ copy }: { copy: SpacingCopy }) => (
  <div className={s.inlineTile}>
    <InsetCard copy={copy} />
    <span className={s.caption}>{`--space-md · ${sum(12)}`}</span>
  </div>
);
