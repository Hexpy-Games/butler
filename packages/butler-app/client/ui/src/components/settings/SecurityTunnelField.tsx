import type { ButlerAccountStatus } from "@/app/butlerAccount";
import { appCopy } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";
import type { SecurityView } from "@/app/types.ts";
import { Button, SettingsField, Stack, Tag, Typo } from "@/butler-ds";
import { SettingsSwitch } from "./SettingsSwitch";

export function SecurityTunnelField({ tunnel, account, justEnabled, disabled, onChange }: {
  tunnel: NonNullable<SecurityView["tunnel"]>;
  account: ButlerAccountStatus | null;
  justEnabled: boolean;
  disabled: boolean;
  onChange: (enabled: boolean) => void;
}) {
  const copy = appCopy.settings.security;
  const label = <>{copy.tunnel}<Tag>{appCopy.butlerAccount.plans.plus}</Tag></>;
  if (tunnel.enabled || !account || (account.signed_in && account.entitlements.features.tunnel === true)) {
    return (
      <SettingsSwitch
        settingId="tunnel"
        label={label}
        description={copy.tunnelDescription}
        checked={tunnel.enabled}
        disabled={disabled}
        onChange={onChange}
        afterControl={(tunnel.state === "connected" || (tunnel.enabled && justEnabled)) && (
          <Stack gap="xs">
            {tunnel.state === "connected" && (
              <Typo.Caption tone="success" role="status">{copy.tunnelConnected}</Typo.Caption>
            )}
            {tunnel.enabled && justEnabled && <Typo.Caption tone="secondary">{copy.tunnelQrNote}</Typo.Caption>}
          </Stack>
        )}
      />
    );
  }

  return (
    <SettingsField
      settingId="tunnel"
      label={label}
      description={copy.tunnelDescription}
      control={!account.signed_in ? (
        <Button size="sm" variant="secondary" onClick={() => useButlerStore.getState().openSettings("account")}>
          {appCopy.butlerAccount.signIn}
        </Button>
      ) : null}
    />
  );
}
