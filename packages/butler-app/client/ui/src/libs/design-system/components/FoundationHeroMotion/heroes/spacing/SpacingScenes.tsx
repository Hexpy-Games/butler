import type { CSSProperties } from "react";
import { SettingsField } from "../../../../blocks/SettingsField";
import { SettingsSection } from "../../../../blocks/SettingsSection";
import { Switch } from "../../../Switch";
import { Reveal as R } from "../shared/Reveal";
import { Roller } from "../shared/Roller";
import { BANDS, COMPACT_PAD, RHYTHM, STEPS, UNIT, type SpacingCopy } from "./spacingCopy";
import { Section, Staircase, count } from "./spacingTiles";
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

/** Scene 2: one block under the camera, then the named steps built from it, with a readout rolling `px = n×4`. */
export function StairScene({ copy }: { copy: SpacingCopy }) {
  return (
    <div className={s.stairStage} data-m="stairs">
      <Staircase marks name="st" />
      <span className={s.unit} data-m="unit" data-t="unit" />
      <div className={s.readout} data-t="st-read">
        <span className={s.readLine}>
          <Roller className={s.bigValue} id="stp" poster={STEPS.length - 1} values={STEPS.map(([, px]) => String(px))} />
          <span className={s.readEq}>=</span>
          <Roller className={s.bigValue} id="stn" poster={STEPS.length - 1} values={STEPS.map(([, px]) => String(count(px)))} />
          <span className={s.readEq}>{`×${UNIT}`}</span>
        </span>
        <span className={s.readToken}>--space-<Roller id="sts" poster={STEPS.length - 1} values={STEPS.map(([name]) => name)} /></span>
        <span className={s.readUnit}><R name="st-unit">{copy.unit}</R></span>
      </div>
    </div>
  );
}

/** Scene 3 (signature): a real settings section pulled apart; each space fills with blocks, counted; then it snaps shut. */
export function ExplodeScene({ copy }: { copy: SpacingCopy }) {
  const gap = BANDS.find((band) => band.id === "fg")!;
  const counts = Array.from({ length: count(gap.px) }, (_, k) => k + 1);
  return (
    <div className={s.explodeStage} data-m="ex">
      <div className={s.readout} data-t="ex-read">
        <span className={s.readLine}>
          <Roller className={s.bigValue} id="exp" poster={counts.length - 1} values={counts.map((n) => String(n * UNIT))} />
          <span className={s.readEq}>=</span>
          <Roller className={s.bigValue} id="exn" poster={counts.length - 1} values={counts.map(String)} />
          <span className={s.readEq}>{`×${UNIT}`}</span>
        </span>
        <span className={s.readToken}>{gap.token}</span>
      </div>
      <Section copy={copy} name="ex" tags />
    </div>
  );
}

/** Scene 4: the whole page's rhythm, counted on the right margin: in a group, between rows, between sections. */
export function RhythmScene({ copy }: { copy: SpacingCopy }) {
  const labels = [copy.inGroup, copy.betweenRows, copy.betweenSections];
  const bracket = (k: number) => {
    const step = RHYTHM[k]!;
    return (
      <span className={s.bracket} data-r={step.id} data-t={`rh-${k}`}>
        <span className={s.bracketBlocks} style={{ "--n": count(step.px) } as CSSProperties} />
        <span className={s.bracketLabel}><b>{count(step.px)}</b>{` · ${step.px} · ${labels[k]}`}</span>
      </span>
    );
  };
  return (
    <div className={s.rhythmStage} data-m="rh">
      <div className={s.page}>
        <div className={s.pageSection}>
          <SettingsSection id="space-hero-general" kind="form" title={copy.general}>
            <div className={s.field}>
              {bracket(0)}
              <SettingsField control={<Switch aria-label={copy.sync} checked onCheckedChange={() => undefined} />} description={copy.syncHint} label={copy.sync} />
            </div>
            <div className={s.field}>
              {bracket(1)}
              <SettingsField control={<Switch aria-label={copy.sounds} checked={false} onCheckedChange={() => undefined} />} description={copy.soundsHint} label={copy.sounds} />
            </div>
          </SettingsSection>
        </div>
        <div className={s.pageSection}>
          {bracket(2)}
          <SettingsSection id="space-hero-notifications" kind="form" title={copy.notifications}>
            <SettingsField control={<Switch aria-label={copy.badge} checked onCheckedChange={() => undefined} />} description={copy.badgeHint} label={copy.badge} />
          </SettingsSection>
        </div>
      </div>
    </div>
  );
}

/** Scene 5: comfortable and compact side by side; the compact inset drops two blocks. */
export function DensityScene({ copy }: { copy: SpacingCopy }) {
  const pad = BANDS.find((band) => band.id === "pt")!;
  return (
    <div className={s.densityStage} data-m="dn">
      <div className={s.densityCol}>
        <span className={s.densityHead}><span>{copy.comfortable}</span><span className={s.readToken}>{`${pad.token} ${pad.px}`}</span></span>
        <Section copy={copy} name="dc" />
      </div>
      <div className={s.densityCol}>
        <span className={s.densityHead}>
          <span>{copy.compact}</span>
          <span className={s.readToken}>{`${pad.token} `}<Roller id="dnp" poster={1} values={[String(pad.px), String(COMPACT_PAD)]} /></span>
        </span>
        <Section copy={copy} density="compact" name="dk" />
      </div>
    </div>
  );
}
