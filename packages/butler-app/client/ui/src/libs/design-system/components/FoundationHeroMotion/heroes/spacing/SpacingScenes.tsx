import { SettingsField } from "../../../../blocks/SettingsField";
import { SettingsSection } from "../../../../blocks/SettingsSection";
import { Switch } from "../../../Switch";
import { Reveal as R } from "../shared/Reveal";
import { Roller } from "../shared/Roller";
import { COMPACT_PAD, GAPS, STEPS, UNIT, type GapId, type SpacingCopy } from "./spacingCopy";
import { Gap, GapLabel, Section, Staircase, count } from "./spacingTiles";
import s from "./SpacingHero.module.css";

/** The title's touch: its letters drift apart and 4px blocks sit in the gaps. */
export function TitleLetters({ title }: { title: string }) {
  const letters = [...title];
  return (
    <span className={s.letters}>
      {letters.map((ch, k) => (
        <span className={s.letter} data-t={`tl-${k}`} key={k}>
          {ch}
          {k < letters.length - 1 ? <span className={s.letterBlock} data-t={`tb-${k}`} /> : null}
        </span>
      ))}
    </span>
  );
}

/** The last value first, so the poster rests on it; each value cuts in (left aligned, no padding). */
function Cut({ id, values }: { id: string; values: string[] }) {
  return (
    <span className={s.cut}>
      {values.map((value, k) => <span data-last={k === values.length - 1 ? "" : undefined} data-t={`${id}-${k}`} key={value}>{value}</span>)}
    </span>
  );
}

/**
 * Scene 2: one 4px unit, drawn large and named; it shrinks into the xs slot
 * and the named steps build from it, each with its size; the readout counts
 * `px = n×4`.
 */
export function StairScene({ copy }: { copy: SpacingCopy }) {
  const last = STEPS.length - 1;
  return (
    <div className={s.stairStage} data-m="stairs">
      <Staircase name="st" unit={<span className={s.unit} data-m="unit" data-t="unit" />} />
      <div className={s.readout} data-t="st-read">
        <span className={s.readToken}>--space-<Cut id="sts" values={STEPS.map(([name]) => name)} /></span>
        <span className={s.readLine}>
          <Roller className={s.bigValue} id="stp" poster={last} values={STEPS.map(([, px]) => String(px))} />
          <span className={s.readUnit}>px</span>
        </span>
        <span className={s.readLine}>
          <Roller className={s.midValue} id="stn" poster={last} values={STEPS.map(([, px]) => String(count(px)))} />
          <span className={s.readUnit}>{`× ${UNIT}px`}</span>
        </span>
      </div>
      <span className={s.unitLabel} data-t="unit-l">
        <span className={s.unitName}><R name="unit-t">{copy.unit}</R></span>
        <span className={s.readToken}><R name="unit-k">--space-xs</R></span>
      </span>
    </div>
  );
}

/** Scene 3 (signature): a real settings section; each space in turn is highlighted, counted in units beside it and named. */
export function CountScene({ copy }: { copy: SpacingCopy }) {
  return (
    <div className={s.countStage} data-m="ex">
      <Section copy={copy} labels="full" name="ex" />
    </div>
  );
}

/** The rhythm's measures: in a group (header gap), between rows (field gap), between sections. */
export const RHYTHM: GapId[] = ["hg", "fg", "sg"];

/** Scene 4: the whole page's rhythm, counted on the right: in a group, between rows, between sections. */
export function RhythmScene({ copy }: { copy: SpacingCopy }) {
  const notes = [copy.inGroup, copy.betweenRows, copy.betweenSections];
  const gap = (k: number) => {
    const id = RHYTHM[k]!;
    return <Gap id={id} label={<GapLabel note={notes[k]} px={GAPS[id].px} reveal={`rh-${k}-l`} />} n={count(GAPS[id].px)} name={`rh-${k}`} />;
  };
  const row = (label: string, hint: string, on: boolean) => <SettingsField control={<Switch aria-label={label} checked={on} onCheckedChange={() => undefined} />} description={hint} label={label} />;
  return (
    <div className={s.rhythmStage} data-m="rh">
      <div className={s.page}>
        <div className={s.pageSection}>
          <SettingsSection id="space-hero-general" kind="form" title={copy.general}>
            <div className={s.field}>{gap(0)}{row(copy.sync, copy.syncHint, true)}</div>
            <div className={s.field}>{gap(1)}{row(copy.sounds, copy.soundsHint, false)}</div>
          </SettingsSection>
        </div>
        <div className={s.pageSection}>
          {gap(2)}
          <SettingsSection id="space-hero-notifications" kind="form" title={copy.notifications}>
            {row(copy.badge, copy.badgeHint, true)}
          </SettingsSection>
        </div>
      </div>
    </div>
  );
}

/** Scene 5: comfortable beside compact; only the card inset changes, 6 units to 4. */
export function DensityScene({ copy }: { copy: SpacingCopy }) {
  const head = (name: string, px: number, id: string) => (
    <span className={s.densityHead}>
      <span><R name={`${id}-h`}>{name}</R></span>
      <span className={s.readToken}><R name={`${id}-k`}>{`${GAPS.pt.token} ${px}`}</R></span>
    </span>
  );
  return (
    <div className={s.densityStage} data-m="dn">
      <div className={s.densityCol}>{head(copy.comfortable, GAPS.pt.px, "dc")}<Section copy={copy} labels="short" name="dc" only={["pt", "pb"]} /></div>
      <div className={s.densityCol}>{head(copy.compact, COMPACT_PAD, "dk")}<Section copy={copy} density="compact" labels="short" name="dk" only={["pt", "pb"]} /></div>
    </div>
  );
}
