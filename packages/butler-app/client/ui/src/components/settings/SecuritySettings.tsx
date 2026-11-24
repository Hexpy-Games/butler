import { butlerVaultSection, useButlerVaultSectionState } from "./ButlerVaultSection";
import { computersSection } from "./ComputersSection";
import { useComputersSection } from "./hooks/useComputersSection";
import { securityAuthoritySections } from "./SecurityAuthoritySections";
import { useConnectedAccounts } from "./hooks/useConnectedAccounts";
import { useSavedKeys } from "./hooks/useSavedKeys";
import { useAllowedFolders } from "./useAllowedFolders";
import { useGrants } from "./useGrants";
import { memo, useId, useState } from "react";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import { DisclosureRow, SettingsField, SettingsFieldGroup, Stack } from "@/butler-ds";
import { SettingsPage, SettingsSection } from "./SettingsFormComponents";
import { SecurityAllowedHostsField } from "./SecurityAllowedHostsField";
import { securityPairingSection } from "./SecurityPairingSection";
import { securityDevicesSection } from "./SecurityDevicesSection";
import { SecurityRemoteAccessFields } from "./SecurityRemoteAccessFields";
import { useMinuteClock } from "@/app/space/minute-clock.ts";
import { usePairedDevices } from "./usePairedDevices";
import { usePairingSession } from "./usePairingSession";
import { useSecuritySettings } from "./useSecuritySettings";

/**
 * Settings → Security: LAN access and remote pairing (clients on this
 * computer only). Allowed hosts sit in a collapsed Advanced disclosure.
 */
export const SecuritySettings = memo(function SecuritySettings() {
  useAppLocale();
  const security = useSecuritySettings();
  const computersState = useComputersSection();
  const vault = useButlerVaultSectionState();
  const savedKeys = useSavedKeys();
  const accounts = useConnectedAccounts();
  const grants = useGrants();
  const folders = useAllowedFolders();
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const settingsCopy = appCopy.settings;
  const sections = settingsCopy.pageSections;
  const { view, load, busy } = security;
  const refused = load === "host-only" || load === "admin-required" || load === "error";
  const remoteEnabled = !refused && Boolean(view?.remote_access_enabled);
  const pairingEnabled = remoteEnabled || Boolean(view?.tunnel?.enabled);
  const pairing = usePairingSession(pairingEnabled);
  const devices = usePairedDevices(pairingEnabled);
  const now = useMinuteClock(pairingEnabled && devices.devices.length > 0);
  const panelId = useId();
  const hintId = useId();
  const contentHintId = useId();

  if (refused) {
    return (
      <SettingsPage>
        {butlerVaultSection(vault)}
        <SettingsSection
          id="remote-access"
          kind="form"
          title={sections.remoteAccess}
          state={load === "host-only" ? "empty" : "error"}
          emptyMessage={settingsCopy.security.hostOnly}
          errorMessage={load === "admin-required" ? settingsCopy.security.adminRequired : undefined}
          onRetry={security.retry}
        />
        {securityAuthoritySections({ savedKeys, grants, accounts, folders })}
      </SettingsPage>
    );
  }

  const state = view ? "ready" : "loading";
  return (
    <SettingsPage>
      {butlerVaultSection(vault)}
      <SettingsSection id="remote-access" kind="form" title={sections.remoteAccess} state={state}>
        {view && (
          <SecurityRemoteAccessFields
            view={view}
            account={security.account}
            justEnabled={security.justEnabled}
            onTunnelChange={(enabled) => void security.toggleTunnel(enabled)}
            disabled={busy !== null}
            onChange={(enabled) => void security.toggleRemoteAccess(enabled)}
          />
        )}
      </SettingsSection>
      {view && pairingEnabled && (
        <>
          {securityPairingSection({ disabled: busy !== null, addresses: view.lan_urls, pairing, tunnel: view.tunnel })}
          {securityDevicesSection({ disabled: busy !== null, devices, now })}
        </>
      )}
      {computersSection({ section: computersState, savedKeys: savedKeys.credentials })}
      {securityAuthoritySections({ savedKeys, grants, accounts, folders })}
      {view && securityAdvancedSection({
        security, open: advancedOpen, onToggle: () => setAdvancedOpen(!advancedOpen), panelId, hintId, contentHintId,
      })}
    </SettingsPage>
  );
});

function securityAdvancedSection({ security, open, onToggle, panelId, hintId, contentHintId }: {
  security: ReturnType<typeof useSecuritySettings>;
  open: boolean;
  onToggle: () => void;
  panelId: string;
  hintId: string;
  contentHintId: string;
}) {
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
                control={<SecurityAllowedHostsField hosts={view.allowed_hosts} otherHosts={view.content_hosts ?? []} disabled={busy !== null} onSave={security.saveAllowedHosts} describedBy={hintId} />}
              />
              <SettingsField
                label={copy.contentHosts}
                description={copy.contentHostsDescription}
                descriptionId={contentHintId}
                control={<SecurityAllowedHostsField content hosts={view.content_hosts ?? []} otherHosts={view.allowed_hosts} disabled={busy !== null} onSave={security.saveContentHosts} describedBy={contentHintId} />}
              />
            </SettingsFieldGroup>
          </Stack.Item>
        </Stack>
      </DisclosureRow>
    </SettingsSection>
  );
}
