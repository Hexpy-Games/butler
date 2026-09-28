import { useState } from "react";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import { DisclosureRow } from "@/butler-ds";
import { SettingsPage, SettingsSection } from "./SettingsFormComponents";
import { SecurityAllowedHostsField } from "./SecurityAllowedHostsField";
import { SecurityConnectionCodeField } from "./SecurityConnectionCodeField";
import { SecurityRemoteAccessFields } from "./SecurityRemoteAccessFields";
import { useSecuritySettings } from "./useSecuritySettings";

/**
 * Settings → Security: LAN access and the connection code (clients on this
 * computer only). Allowed hosts sit in a collapsed Advanced disclosure.
 */
export function SecuritySettings() {
  useAppLocale();
  const security = useSecuritySettings();
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
      </SettingsPage>
    );
  }

  const state = view ? "ready" : "loading";
  const connectionCode = view ? view.connection_code : undefined;
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
      {connectionCode !== null && (
        <SettingsSection id="connection-code" kind="form" title={sections.connectionCode} state={state}>
          {connectionCode && (
            <SecurityConnectionCodeField
              code={connectionCode}
              revealed={security.revealed}
              disabled={busy !== null}
              onReveal={() => void security.toggleReveal()}
              onCopy={() => void security.copyCode()}
              onRotate={() => void security.rotate()}
            />
          )}
        </SettingsSection>
      )}
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
        </SettingsSection>
      )}
    </SettingsPage>
  );
}
