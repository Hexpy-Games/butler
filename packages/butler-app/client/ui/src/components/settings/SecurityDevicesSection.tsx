import { appCopy } from "@/app/copy.ts";
import { Button, ListRow, Monitor, SettingsSection, Smartphone, Stack, Tooltip } from "@/butler-ds";
import { relativeTimeSince } from "@/lib/relativeTime";
import type { usePairedDevices } from "./usePairedDevices";

export function securityDevicesSection({ disabled, devices, now }: {
  disabled: boolean;
  devices: ReturnType<typeof usePairedDevices>;
  now: number;
}) {
  const copy = appCopy.settings.security;
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
            <ListRow icon={device.kind === "browser" ? <Monitor size="md" /> : <Smartphone size="md" />} title={device.name}
              description={device.ip} meta={relativeTimeSince(Math.max(0, now * 60 - device.last_seen_at))} />
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
