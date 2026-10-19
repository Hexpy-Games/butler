import { appCopy, useAppLocale } from "@/app/copy.ts";
import { Button, SettingsField, SettingsSection, Spinner, Tooltip } from "@/butler-ds";
import { useFullReset } from "./hooks/useFullReset";

/** Settings > General: erase all Butler data and restart (desktop app only). Details stay in the dialog. */
export function FullResetSection() {
  useAppLocale();
  const copy = appCopy.settings;
  const reset = useFullReset();
  const reason = reset.available ? undefined : copy.fullReset.desktopOnly;
  const label = reset.running ? copy.fullReset.resetting : copy.fullReset.action;
  return <SettingsSection id="full-reset" kind="form" title={copy.pageSections.fullReset}>
    <SettingsField id="full-reset" settingId="full-reset" label={copy.fullReset.label} description={copy.fullReset.description}
      descriptionId="full-reset-description"
      control={<Tooltip label={reason}>
        <Button id="full-reset" type="button" variant="destructive" aria-describedby="full-reset-description"
          aria-disabled={Boolean(reason) || reset.running || undefined} aria-label={reason ? `${label}. ${reason}` : label}
          aria-busy={reset.running || undefined} iconStart={reset.running ? <Spinner size={14} /> : undefined}
          onClick={() => { void reset.start(); }}>{label}</Button>
      </Tooltip>} />
  </SettingsSection>;
}
