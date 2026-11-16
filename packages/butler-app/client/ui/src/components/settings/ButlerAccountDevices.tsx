import { appCopy, getAppLocale } from "@/app/copy";
import { useMinuteClock } from "@/app/space/minute-clock";
import { Button, ListRow, Monitor, SettingsSection, Stack, Tooltip } from "@/butler-ds";
import type { useButlerAccount } from "./hooks/useButlerAccount";

function lastSeen(value: string | null, now: number) {
  if (!value) return undefined;
  const elapsed = Math.max(0, now * 60 - Date.parse(value) / 1000);
  const format = new Intl.RelativeTimeFormat(getAppLocale(), { numeric: "auto" });
  if (elapsed < 60) return format.format(0, "minute");
  if (elapsed < 3600) return format.format(-Math.floor(elapsed / 60), "minute");
  if (elapsed < 86400) return format.format(-Math.floor(elapsed / 3600), "hour");
  return format.format(-Math.floor(elapsed / 86400), "day");
}

export function ButlerAccountDevices({ account }: { account: ReturnType<typeof useButlerAccount> }) {
  const copy = appCopy.butlerAccount;
  const now = useMinuteClock(account.devices.length > 0);
  if (account.state === "unsupported") return null;
  return (
    <SettingsSection id="butler-account-devices" kind="list" title={copy.devices} state={account.state}
      errorMessage={copy.loadFailed} onRetry={() => void account.reload()}>
      {account.devices.map((device) => (
        <Stack key={device.id} align="row" cross="center" gap="sm" wrap>
          <Stack grow minWidth="0">
            <ListRow icon={<Monitor size="md" />} title={device.name}
              description={device.current ? copy.thisDevice : copy.platforms[device.platform] ?? device.platform}
              meta={lastSeen(device.last_seen_at, now)} />
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
