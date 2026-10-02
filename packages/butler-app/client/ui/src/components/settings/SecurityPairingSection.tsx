import { appCopy } from "@/app/copy.ts";
import { Button, SettingsField, SettingsSection, Stack, Tooltip, Typo } from "@/butler-ds";
import { usePairingSession } from "./usePairingSession";

export function SecurityPairingSection({ disabled }: { disabled: boolean }) {
  const copy = appCopy.settings.security;
  const pairing = usePairingSession();
  const unavailable = disabled || pairing.busy || Boolean(pairing.code);
  const digits = pairing.busy ? undefined : pairing.code?.code;
  return (
    <SettingsSection id="device-pairing" kind="form" title={copy.pairDevice}>
      <SettingsField settingId="pairing-code" label={copy.code} controlWidth="full" control={(
        <Stack gap="sm" cross="start">
          {digits && (
            <Stack gap="xs">
              <Typo.MetricValue numeric="tabular" wrap="nowrap" data-test-class="pairing-code">
                {digits.slice(0, 4)} {digits.slice(4)}
              </Typo.MetricValue>
              <Typo.Caption tone="secondary">{copy.expiresIn(pairing.remaining)}</Typo.Caption>
            </Stack>
          )}
          {pairing.invalidated && <Typo.Caption tone="secondary">{copy.invalidated}</Typo.Caption>}
          {pairing.paired && <Typo.Caption tone="success" role="status">{copy.paired}</Typo.Caption>}
          {!digits && (
            <Tooltip label={unavailable ? copy.working : copy.pairDevice}>
              <Button size="sm" variant="outline" disabled={unavailable} onClick={() => void pairing.issue()}>
                {copy.pairDevice}
              </Button>
            </Tooltip>
          )}
        </Stack>
      )} />
    </SettingsSection>
  );
}
