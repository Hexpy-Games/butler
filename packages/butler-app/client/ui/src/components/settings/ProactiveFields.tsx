import { appCopy, useAppLocale } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";
import type { SettingsView } from "@/app/types.ts";
import { Inline, SegmentedControl, SettingsField, TimePicker, Typo } from "@/butler-ds";
import { useSettingsUIStore } from "@/stores/settingsUIStore.ts";

export function ProactiveFields() {
  const locale = useAppLocale();
  const copy = appCopy.settings.memory;
  const draft = useSettingsUIStore(state => state.draft);
  const saving = useSettingsUIStore(state => state.saving);
  const update = useSettingsUIStore(state => state.update);
  const setSettings = useButlerStore(state => state.setSettings);
  const disabled = !draft || saving;
  const options = [{ value: "off", label: copy.proactiveOff }, { value: "sometimes", label: copy.proactiveSometimes }, { value: "often", label: copy.proactiveOften }];
  return <>
    <SettingsField settingId="proactive-level" label={copy.proactiveLevel} description={copy.proactiveDescription}
      control={<SegmentedControl ariaLabel={copy.proactiveLevel} value={draft?.proactive_level ?? "sometimes"}
        options={options.map(option => ({ ...option, disabled }))}
        onValueChange={value => { void update({ proactive_level: value as SettingsView["proactive_level"] }, setSettings); }} />} />
    <SettingsField settingId="quiet-hours" label={copy.quietHours} description={copy.quietHoursDescription}
      control={<Inline gap="xs" wrap={false}>
        <TimePicker value={draft?.quiet_hours_start ?? "22:00"} locale={locale} disabled={disabled} aria-label={copy.quietHoursStart} pickerLabel={copy.pickTime}
          onValueChange={value => { void update({ quiet_hours_start: value }, setSettings); }} />
        <Typo.Body as="span" tone="secondary">–</Typo.Body>
        <TimePicker value={draft?.quiet_hours_end ?? "07:00"} locale={locale} disabled={disabled} aria-label={copy.quietHoursEnd} pickerLabel={copy.pickTime}
          onValueChange={value => { void update({ quiet_hours_end: value }, setSettings); }} />
      </Inline>} />
  </>;
}
