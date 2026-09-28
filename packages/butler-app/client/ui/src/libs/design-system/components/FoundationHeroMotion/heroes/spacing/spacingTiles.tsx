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
import { BANDS, STEPS, UNIT, type BandId, type SpacingCopy } from "./spacingCopy";
import s from "./SpacingHero.module.css";

/** Blocks a space holds. */
export const count = (px: number) => px / UNIT;

/**
 * A space filled with 4px blocks, one row per block (named `${name}-${j}` for
 * the timeline). It is anchored by CSS to the field it sits against and sized
 * by the live token, so the rows fit it exactly. `rows` may exceed the space
 * (the compact copy): the extra rows overflow away from the field.
 */
export function Band({ band, name, rows, tag }: { band: BandId; name?: string; rows: number; tag?: ReactNode }) {
  return (
    <span className={s.band} data-band={band} data-t={name}>
      {Array.from({ length: rows }, (_, j) => <span className={s.row} data-t={name ? `${name}-${j}` : undefined} key={j} />)}
      {tag ? <span className={s.tag}>{tag}</span> : null}
    </span>
  );
}

function field(label: string, hint: string, on: boolean) {
  return <SettingsField control={<Switch aria-label={label} checked={on} onCheckedChange={() => undefined} />} description={hint} label={label} />;
}

/** The tag of a band: token, px, and its count of blocks. */
export function bandTag(id: BandId, reveal?: string) {
  const band = BANDS.find((item) => item.id === id)!;
  const text = `${band.token} · ${band.px} = ${count(band.px)}×${UNIT}`;
  return reveal ? <R name={reveal}>{text}</R> : text;
}

/**
 * A real settings section (two fields) with its spaces counted in blocks:
 * the header gap and top inset above the first field, the field gap and the
 * bottom inset around the second. `name` prefixes the timeline's parts;
 * `density` pins the card inset (compact tightens only the inset);
 * `rest` shows the blocks faint (the poster).
 */
export function Section({ copy, name, density = "comfortable", rows, tags = false, rest = false }: {
  copy: SpacingCopy; name?: string; density?: "comfortable" | "compact"; rows?: Partial<Record<BandId, number>>; tags?: boolean; rest?: boolean;
}) {
  const n = (band: BandId) => rows?.[band] ?? count(BANDS.find((item) => item.id === band)!.px);
  const part = (band: BandId) => (name ? `${name}-${band}` : undefined);
  const tag = (band: BandId) => (tags ? bandTag(band, name ? `${name}-${band}-tag` : undefined) : undefined);
  return (
    <div className={s.section} data-density={density} data-rest={rest ? "" : undefined} data-t={name}>
      <SettingsSection id={`space-hero-${name ?? "tile"}`} kind="form" title={copy.general}>
        <div className={s.field} data-t={name ? `${name}-f1` : undefined}>
          <Band band="hg" name={part("hg")} rows={n("hg")} tag={tag("hg")} />
          <Band band="pt" name={part("pt")} rows={n("pt")} tag={tag("pt")} />
          {field(copy.sync, copy.syncHint, true)}
        </div>
        <div className={s.field} data-t={name ? `${name}-f2` : undefined}>
          <Band band="fg" name={part("fg")} rows={n("fg")} tag={tag("fg")} />
          {field(copy.sounds, copy.soundsHint, false)}
          <Band band="pb" name={part("pb")} rows={n("pb")} tag={tag("pb")} />
        </div>
      </SettingsSection>
    </div>
  );
}

/** The named scale as columns of blocks (rows on the tall canvas), each named under it; `name` prefixes the timeline's parts. */
export function Staircase({ name, marks = false }: { name?: string; marks?: boolean }) {
  return (
    <div className={s.stairs}>
      {STEPS.map(([step, px], k) => (
        <span className={s.step} key={step}>
          <span className={s.stepTrack}>
            <span className={s.column} data-m={marks && k === 0 ? "st-0" : undefined} data-t={name ? `${name}-${k}` : undefined} style={{ "--n": count(px) } as CSSProperties} />
          </span>
          <span className={s.stepName} data-t={name ? `${name}-n${k}` : undefined}>
            <span>{step}</span>
            <span className={s.stepPx}>{px}</span>
          </span>
        </span>
      ))}
    </div>
  );
}

/** Two buttons, the 2-block gap between them visible. */
export function Inline({ copy, name }: { copy: SpacingCopy; name?: string }) {
  return (
    <ButtonContainer size="default">
      <Button text={copy.cancel} variant="outline" />
      <span className={s.after}>
        <span className={s.gapBlocks} data-t={name} />
        <Button text={copy.save} />
      </span>
    </ButtonContainer>
  );
}

/** A card, its inset shown as a frame of blocks. */
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
    </span>
  );
}

/** Finale tiles. */
export const StairsTile = () => <div className={s.stairsTile}><Staircase /></div>;
export const SectionTile = ({ copy }: { copy: SpacingCopy }) => <div className={s.sectionTile}><Section copy={copy} rest /></div>;
export const InlineTile = ({ copy }: { copy: SpacingCopy }) => (
  <div className={s.inlineTile}>
    <Inline copy={copy} />
    <span className={s.caption}>--space-sm · 8 = 2×4</span>
  </div>
);
export const CardTile = ({ copy }: { copy: SpacingCopy }) => (
  <div className={s.inlineTile}>
    <InsetCard copy={copy} />
    <span className={s.caption}>--space-md · 12 = 3×4</span>
  </div>
);
