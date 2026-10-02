import { appCopy, getAppLocale } from "@/app/copy.ts";
import { useMinuteClock } from "@/app/space/minute-clock.ts";
import { Button, ListRow, Monitor, SettingsSection, Stack, Tooltip } from "@/butler-ds";
import { usePairedDevices } from "./usePairedDevices";

function lastSeen(seconds: number, now: number) {
  const elapsed = Math.max(0, now * 60 - seconds);
  const format = new Intl.RelativeTimeFormat(getAppLocale(), { numeric: "auto" });
  if (elapsed < 60) return format.format(0, "minute");
  if (elapsed < 3600) return format.format(-Math.floor(elapsed / 60), "minute");
  if (elapsed < 86400) return format.format(-Math.floor(elapsed / 3600), "hour");
  return format.format(-Math.floor(elapsed / 86400), "day");
}

export function SecurityDevicesSection({ disabled }: { disabled: boolean }) {
  const copy = appCopy.settings.security;
  const devices = usePairedDevices();
  const now = useMinuteClock(devices.devices.length > 0);
  const unavailable = disabled || devices.busy;
  return (
    <SettingsSection id="paired-devices" kind="list" title={copy.devices}
      state={devices.state === "ready" && !devices.devices.length ? "empty" : devices.state}
      emptyMessage={copy.noDevices} onRetry={() => void devices.refresh()}
      actions={(
        <Tooltip label={unavailable ? copy.working : devices.devices.length ? copy.revokeAll : copy.noDevices}>
          <Button size="sm" variant="outline" disabled={unavailable || !devices.devices.length}
            onClick={() => void devices.revoke()}>{copy.revokeAll}</Button>
        </Tooltip>
      )}>
      {devices.devices.map((device) => (
        <Stack key={device.id} align="row" cross="center" gap="sm" wrap>
          <Stack grow minWidth="0">
            <ListRow icon={<Monitor size="md" />} title={device.name}
              description={device.ip} meta={lastSeen(device.last_seen_at, now)} />
          </Stack>
          <Tooltip label={unavailable ? copy.working : copy.revokeDevice(device.name)}>
            <Button size="sm" variant="outline" disabled={unavailable}
              aria-label={copy.revokeDevice(device.name)} onClick={() => void devices.revoke(device.id)}>
              {copy.revoke}
            </Button>
          </Tooltip>
        </Stack>
      ))}
    </SettingsSection>
  );
}
