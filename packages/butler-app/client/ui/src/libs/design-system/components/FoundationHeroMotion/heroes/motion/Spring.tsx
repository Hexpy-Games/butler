import { SettingsField } from "../../../../blocks/SettingsField";
import { SettingsSection } from "../../../../blocks/SettingsSection";
import { Switch } from "../../../Switch";
import type { MotionCopy } from "./motionCopy";
import s from "./MotionHero.module.css";

/** Scene 6: bounce is kept for the Switch thumb: a real settings row whose switch toggles on the ticks. */
export function Spring({ copy, live }: { copy: MotionCopy; live: boolean }) {
  const t = (name: string) => (live ? name : undefined);
  const control = (
    <span className={s.switchStack}>
      {live ? <span className={s.switchLayer} data-t="sp-off"><Switch aria-label={copy.field} checked={false} onCheckedChange={() => undefined} /></span> : null}
      <span className={s.switchLayer} data-t={t("sp-on")}><Switch aria-label={copy.field} checked onCheckedChange={() => undefined} /></span>
    </span>
  );
  return (
    <div className={s.spring} data-m={t("spring")}>
      <SettingsSection id={live ? "motion-hero-spring" : "motion-hero-spring-tile"} kind="form">
        <SettingsField control={control} description={copy.fieldHint} label={copy.field} />
      </SettingsSection>
      <span className={s.springNote}>--motion-ease-spring · --motion-base</span>
    </div>
  );
}
