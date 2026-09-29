import { SettingsField } from "../../../../blocks/SettingsField";
import { SettingsSection } from "../../../../blocks/SettingsSection";
import { Switch } from "../../../Switch";
import { GAPS, type SpacingCopy } from "./spacingCopy";
import { Gap } from "./Gap";
import { GapLabel } from "./GapLabel";
import { count } from "./spacingCount";
import { RHYTHM } from "./SpacingScenes";
import s from "./SpacingHero.module.css";

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
