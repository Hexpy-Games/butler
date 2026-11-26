import { appCopy } from "@/app/copy";
import { Button, ListRow, Monitor, SettingsSection, Stack, Tooltip } from "@/butler-ds";
import { relativeTimeSince } from "@/lib/relativeTime";
import type { useButlerAccount } from "./hooks/useButlerAccount";

export function butlerAccountDevicesSection({ account, now }: {
  account: ReturnType<typeof useButlerAccount>;
  now: number;
}) {
  const copy = appCopy.butlerAccount;
  if (account.state === "unsupported") return null;
  return (
    <SettingsSection id="butler-account-devices" kind="list" title={copy.devices} state={account.state}
      errorMessage={copy.loadFailed} onRetry={() => void account.reload()}>
      {account.devices.map((device) => (
        <Stack key={device.id} align="row" cross="center" gap="sm" wrap>
          <Stack grow minWidth="0">
            <ListRow icon={<Monitor size="md" />} title={device.name}
              description={device.current ? copy.thisDevice : copy.platforms[device.platform] ?? device.platform}
              meta={device.last_seen_at
                ? relativeTimeSince(Math.max(0, now * 60 - Date.parse(device.last_seen_at) / 1000))
                : undefined} />
          </Stack>
          {!device.current && <Tooltip label={account.busy ? copy.working : copy.revokeDevice(device.name)}>
            <Button size="sm" variant="outline" disabled={account.busy}
              aria-label={copy.revokeDevice(device.name)} onClick={() => void account.revoke(device)}>{copy.revoke}</Button>
          </Tooltip>}
        </Stack>
      ))}
    </SettingsSection>
  );
}
