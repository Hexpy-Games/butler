import { appCopy } from "@/app/copy.ts";
import { notifyError } from "@/app/notifications.ts";
import type { SecurityView } from "@/app/types.ts";
import { CopyButton, SettingsField, Stack, Typo } from "@/butler-ds";
import { SettingsSwitch } from "./SettingsSwitch";

/** The LAN toggle and addresses other devices open, including tunnel hosts. */
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
  const codes = [...new Set(view.bind_errors?.map(({ code }) => code))];
  const firstCode = codes.find((code) => code && Object.hasOwn(copy.bindErrors, code)) ?? "bind_failed";
  const bindError = codes.length > 0
    ? copy.bindErrors[firstCode as keyof typeof copy.bindErrors]
    : undefined;
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
      {(view.remote_access_enabled || view.lan_urls.length > 0) && (
        <SettingsField
          settingId="lan-urls"
          label={copy.addresses}
          error={bindError}
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
          ) : bindError ? null : (
            <Typo.Caption tone="secondary">{copy.noAddresses}</Typo.Caption>
          )}
        />
      )}
    </>
  );
}
