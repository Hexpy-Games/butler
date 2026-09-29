import { appCopy } from "@/app/copy.ts";
import { notifyError } from "@/app/notifications.ts";
import type { SecurityView } from "@/app/types.ts";
import { CopyButton, SettingsField, Stack, Typo } from "@/butler-ds";
import { SettingsSwitch } from "./SettingsSwitch";

/** The LAN toggle and, while it is on, the addresses other devices open. */
export function SecurityRemoteAccessFields({
  view,
  disabled,
  onChange,
}: {
  view: SecurityView;
  disabled: boolean;
  onChange: (enabled: boolean) => void;
}) {
  const copy = appCopy.settings.security;
  return (
    <>
      <SettingsSwitch
        settingId="remote-access-enabled"
        label={copy.remoteAccess}
        description={copy.remoteAccessDescription}
        checked={view.remote_access_enabled}
        disabled={disabled}
        onChange={onChange}
      />
      {view.remote_access_enabled && (
        <SettingsField
          settingId="lan-urls"
          label={copy.addresses}
          control={view.lan_urls.length > 0 ? (
            <Stack gap="xs">
              {view.lan_urls.map((url) => (
                <Stack key={url} align="row" gap="sm" cross="center">
                  <Typo.Code wrap="anywhere">{url}</Typo.Code>
                  <CopyButton
                    text={url}
                    label={copy.copyAddress}
                    copiedLabel={copy.copied}
                    onError={(error) => notifyError(error, appCopy.interfacePanels.copyFailed)}
                  />
                </Stack>
              ))}
            </Stack>
          ) : (
            <Typo.Caption tone="secondary">{copy.noAddresses}</Typo.Caption>
          )}
        />
      )}
    </>
  );
}
