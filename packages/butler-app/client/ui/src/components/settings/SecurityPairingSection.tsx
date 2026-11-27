import type { SecurityView } from "@/app/types.ts";
import { appCopy } from "@/app/copy.ts";
import { Button, ButtonContainer, QrCode, SettingsField, SettingsSection, Stack, Tooltip, Typo } from "@/butler-ds";
import { pairingLink } from "./pairingLink";
import type { usePairingSession } from "./usePairingSession";

export function securityPairingSection({ disabled, addresses, pairing, tunnel }: {
  disabled: boolean;
  addresses: readonly string[];
  pairing: ReturnType<typeof usePairingSession>;
  tunnel: SecurityView["tunnel"];
}) {
  const copy = appCopy.settings.security;
  const unavailable = disabled || pairing.busy || Boolean(pairing.code);
  const digits = pairing.busy || pairing.request ? undefined : pairing.code?.code;
  const link = digits ? pairingLink(addresses, digits, tunnel?.enabled && tunnel.public_key && tunnel.tunnel_id
    ? { publicKey: tunnel.public_key, tunnelId: tunnel.tunnel_id, cloud: tunnel.cloud }
    : null) : null;
  return (
    <SettingsSection id="device-pairing" kind="form" title={copy.pairDevice}>
      <SettingsField settingId="pairing-code" label={copy.code} controlWidth="full" control={(
        <Stack gap="sm" cross="start">
          {pairing.request && (
            <Stack gap="sm" alignSelf="stretch">
              <Typo.Body wrap="anywhere">{pairing.request.device_name}</Typo.Body>
              <Stack align="row" gap="sm" cross="center" wrap>
                <Typo.Caption>{copy.matchNumber}</Typo.Caption>
                <Typo.MetricValue numeric="tabular" data-test-class="pairing-match">
                  {pairing.request.match_code}
                </Typo.MetricValue>
              </Stack>
              <Typo.Caption tone="secondary">{copy.matchHint}</Typo.Caption>
              <ButtonContainer size="sm" justify="end">
                <Button size="sm" variant="outline" disabled={pairing.busy} onClick={() => void pairing.decide(false)}>
                  {copy.decline}
                </Button>
                <Button size="sm" disabled={pairing.busy} onClick={() => void pairing.decide(true)}>
                  {copy.allow}
                </Button>
              </ButtonContainer>
            </Stack>
          )}
          {digits && (
            <Stack align="row" gap="lg" cross="center" wrap>
              {link && <QrCode value={link} label={copy.pairingQr} data-test-class="pairing-qr" data-pairing-link={link} />}
              <Stack gap="xs">
                <Typo.MetricValue numeric="tabular" wrap="nowrap" data-test-class="pairing-code">
                  {digits.slice(0, 4)} {digits.slice(4)}
                </Typo.MetricValue>
                <Typo.Caption tone="secondary">{copy.expiresIn(pairing.remaining)}</Typo.Caption>
                {link && <Typo.Caption tone="secondary">{copy.scanWithPhone}</Typo.Caption>}
              </Stack>
            </Stack>
          )}
          {pairing.invalidated && <Typo.Caption tone="secondary">{copy.invalidated}</Typo.Caption>}
          {pairing.rejected && <Typo.Caption tone="secondary">{copy.rejected}</Typo.Caption>}
          {pairing.paired && <Typo.Caption tone="success" role="status">{copy.paired}</Typo.Caption>}
          {!digits && !pairing.request && (
            <Tooltip label={unavailable ? copy.working : copy.createCode}>
              <Button size="sm" variant="outline" disabled={unavailable} onClick={() => void pairing.issue()}>
                {copy.createCode}
              </Button>
            </Tooltip>
          )}
        </Stack>
      )} />
    </SettingsSection>
  );
}
