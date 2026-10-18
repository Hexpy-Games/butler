import { appCopy, useAppLocale } from "@/app/copy.ts";
import { Button, SettingsSection, Spinner, Stack, Tooltip, Typo } from "@/butler-ds";
import { useFullReset } from "./hooks/useFullReset";

/** Settings > Memory: erase all Butler data and restart (desktop app only). */
export function FullResetSection({ locked }: { locked: boolean }) {
  useAppLocale();
  const copy = appCopy.settings;
  const reset = useFullReset();
  const reason = !reset.available ? copy.fullReset.desktopOnly : locked && !reset.running ? copy.memory.inUse : undefined;
  const label = reset.running ? copy.fullReset.resetting : copy.fullReset.action;
  const facts = [{ label: copy.memory.removed, text: copy.fullReset.removed }, { label: copy.memory.kept, text: copy.fullReset.kept }];
  return <SettingsSection id="full-reset" kind="status" title={copy.pageSections.fullReset} description={copy.pageSectionDescriptions.fullReset}
    actions={<Tooltip label={reason}>
      <Button type="button" size="sm" variant="outline" aria-disabled={Boolean(reason) || reset.running || undefined}
        aria-label={reason ? `${label}. ${reason}` : label} aria-busy={reset.running || undefined}
        iconStart={reset.running ? <Spinner size={14} /> : undefined} onClick={() => { void reset.start(); }}>{label}</Button>
    </Tooltip>}>
    <Stack gap="sm">
      {facts.map((fact) => <Stack gap="none" key={fact.label}>
        <Typo.Caption tone="secondary">{fact.label}</Typo.Caption>
        <Typo.Body as="div">{fact.text}</Typo.Body>
      </Stack>)}
    </Stack>
  </SettingsSection>;
}
