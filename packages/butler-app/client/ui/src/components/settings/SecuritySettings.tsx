import { securityAuthoritySections } from "./SecurityAuthoritySections";
import { useConnectedAccounts } from "./hooks/useConnectedAccounts";
import { useSavedKeys } from "./hooks/useSavedKeys";
import { useGrants } from "./useGrants";
import { memo, useId, useState } from "react";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import { DisclosureRow, SettingsField, SettingsFieldGroup, Stack } from "@/butler-ds";
import { SettingsPage, SettingsSection } from "./SettingsFormComponents";
import { SecurityAllowedHostsField } from "./SecurityAllowedHostsField";
import { SecurityPairingSection } from "./SecurityPairingSection";
import { SecurityDevicesSection } from "./SecurityDevicesSection";
import { SecurityRemoteAccessFields } from "./SecurityRemoteAccessFields";
import { useSecuritySettings } from "./useSecuritySettings";

/**
 * Settings → Security: LAN access and remote pairing (clients on this
 * computer only). Allowed hosts sit in a collapsed Advanced disclosure.
 */
export const SecuritySettings = memo(function SecuritySettings() {
  useAppLocale();
  const security = useSecuritySettings();
  const savedKeys = useSavedKeys();
  const accounts = useConnectedAccounts();
  const grants = useGrants();
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const settingsCopy = appCopy.settings;
  const sections = settingsCopy.pageSections;
  const { view, load, busy } = security;

  if (load === "host-only" || load === "admin-required" || load === "error") {
    return (
      <SettingsPage>
        <SettingsSection
          id="remote-access"
          kind="form"
          title={sections.remoteAccess}
          state={load === "host-only" ? "empty" : "error"}
          emptyMessage={settingsCopy.security.hostOnly}
          errorMessage={load === "admin-required" ? settingsCopy.security.adminRequired : undefined}
          onRetry={security.retry}
        />
        {securityAuthoritySections({ savedKeys, grants, accounts })}
      </SettingsPage>
    );
  }

  const state = view ? "ready" : "loading";
  return (
    <SettingsPage>
      <SettingsSection id="remote-access" kind="form" title={sections.remoteAccess} state={state}>
        {view && (
          <SecurityRemoteAccessFields
            view={view}
            disabled={busy !== null}
            onChange={(enabled) => void security.toggleRemoteAccess(enabled)}
          />
        )}
      </SettingsSection>
      {view?.remote_access_enabled && (
        <>
          <SecurityPairingSection disabled={busy !== null} />
          <SecurityDevicesSection disabled={busy !== null} />
        </>
      )}
      {securityAuthoritySections({ savedKeys, grants, accounts })}
      {view && <SecurityAdvancedSection security={security} open={advancedOpen} onToggle={() => setAdvancedOpen(!advancedOpen)} />}
    </SettingsPage>
  );
});

function SecurityAdvancedSection({ security, open, onToggle }: {
  security: ReturnType<typeof useSecuritySettings>;
  open: boolean;
  onToggle: () => void;
}) {
  const panelId = useId();
  const hintId = useId();
  const contentHintId = useId();
  const copy = appCopy.settings.security;
  const { view, busy } = security;
  if (!view) return null;
  return (
    <SettingsSection id="security-advanced" kind="form" title={copy.advanced}>
      <DisclosureRow
        surface="plain"
        data-test-class="settings-security-advanced"
        data-setting-id="allowed-hosts"
        title={copy.advancedContents}
        meta={copy.hostCount(view.allowed_hosts.length + (view.content_hosts?.length ?? 0))}
        controlsId={panelId}
        open={open}
        onToggle={onToggle}
      >
        <Stack id={panelId} align="row" gap="none">
          <Stack.Item basis="lg" minWidth="0">
            <SettingsFieldGroup>
              <SettingsField
                label={copy.hosts}
                description={copy.hostsDescription}
                descriptionId={hintId}
                control={<SecurityAllowedHostsField hosts={view.allowed_hosts} disabled={busy !== null} onSave={security.saveAllowedHosts} describedBy={hintId} />}
              />
              <SettingsField
                label={copy.contentHosts}
                description={copy.contentHostsDescription}
                descriptionId={contentHintId}
                control={<SecurityAllowedHostsField content hosts={view.content_hosts ?? []} disabled={busy !== null} onSave={security.saveContentHosts} describedBy={contentHintId} />}
              />
            </SettingsFieldGroup>
          </Stack.Item>
        </Stack>
      </DisclosureRow>
    </SettingsSection>
  );
}
