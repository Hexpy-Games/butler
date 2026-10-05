import { useId } from "react";
import { SettingsField, Switch, Tooltip } from "@/butler-ds";
import { t } from "../proposedCopy";
import type { MotionState, ProposalLocale } from "../state";

/**
 * NEW: the reduce-motion setting. A SettingsField + Switch like SettingsSwitch; when the OS
 * already reduces motion the switch reads on, is disabled and names why in a tooltip (the app
 * setting can only add reduction, never remove the OS one).
 */
export function ReduceMotionField({ locale, state, onChange }: {
  locale: ProposalLocale; state: MotionState; onChange: (on: boolean) => void;
}) {
  const id = useId();
  const descriptionId = useId();
  const system = state === "system";
  const control = (
    <Switch id={id} aria-describedby={descriptionId} checked={state !== "off"} disabled={system}
      onCheckedChange={(value) => onChange(value === true)} />
  );
  return (
    <SettingsField
      settingId="reduce-motion"
      data-test-class="toggle-field settings-switch-row"
      id={id}
      label={t(locale, "settings.fields.reduceMotion")}
      description={t(locale, "settings.descriptions.reduceMotion")}
      descriptionId={descriptionId}
      control={system ? <Tooltip label={t(locale, "settings.descriptions.reduceMotionSystem")}>{control}</Tooltip> : control}
    />
  );
}
