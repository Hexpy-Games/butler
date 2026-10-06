import { securityAuthoritySections } from "./SecurityAuthoritySections";
import { useShallow } from "zustand/react/shallow";
import { useSettingsUIStore } from "@/stores/settingsUIStore.ts";
import { useButlerStore } from "@/app/store.ts";
import { useSavedKeys } from "./hooks/useSavedKeys";
import { useGrants } from "./useGrants";
import { memo, useState } from "react";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import { DisclosureRow } from "@/butler-ds";
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
  const draft = useSettingsUIStore(useShallow(state => state.draft && ({
    access_mode: state.draft.access_mode, diagnostics_enabled: state.draft.diagnostics_enabled,
  })));
  const update = useSettingsUIStore(state => state.update);
  const setSettings = useButlerStore(state => state.setSettings);
  const models = { draft, update, setSettings };
  const savedKeys = useSavedKeys();
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
        {securityAuthoritySections({ models, savedKeys, grants })}
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
      {securityAuthoritySections({ models, savedKeys, grants })}
      {view && (
        <SettingsSection id="security-advanced" kind="form" title={settingsCopy.security.advanced}>
          <DisclosureRow
            surface="plain"
            data-test-class="settings-security-advanced"
            title={settingsCopy.security.advancedContents}
            open={advancedOpen}
            onToggle={() => setAdvancedOpen(!advancedOpen)}
          />
        </SettingsSection>
      )}
      {view && advancedOpen && (
        <SettingsSection id="allowed-hosts" kind="form" title={sections.allowedHosts}>
          <SecurityAllowedHostsField
            hosts={view.allowed_hosts}
            disabled={busy !== null}
            onSave={security.saveAllowedHosts}
          />
          <SecurityAllowedHostsField
            content
            hosts={view.content_hosts ?? []}
            disabled={busy !== null}
            onSave={security.saveContentHosts}
          />
        </SettingsSection>
      )}
    </SettingsPage>
  );
});
