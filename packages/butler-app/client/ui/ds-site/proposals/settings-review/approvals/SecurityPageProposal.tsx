import { useState, type ReactNode } from "react";
import { appCopy, useAppLocale } from "@/app/copy";
import { useButlerStore } from "@/app/store";
import { DisclosureRow } from "@/butler-ds";
import { useSavedKeys } from "@/components/settings/hooks/useSavedKeys";
import { PermissionsFields } from "@/components/settings/PermissionsFields";
import { SavedKeysRows } from "@/components/settings/SavedKeysRows";
import { SecurityAllowedHostsField } from "@/components/settings/SecurityAllowedHostsField";
import { SecurityDevicesSection } from "@/components/settings/SecurityDevicesSection";
import { SecurityPairingSection } from "@/components/settings/SecurityPairingSection";
import { SecurityRemoteAccessFields } from "@/components/settings/SecurityRemoteAccessFields";
import { SettingsPage, SettingsSection, SettingsSwitch } from "@/components/settings/SettingsFormComponents";
import { useSecuritySettings } from "@/components/settings/useSecuritySettings";
import { useSettingsUIStore } from "@/stores/settingsUIStore";

// PROPOSAL COPY of components/settings/SecuritySettings.tsx, reorganised. Each section keeps its
// product component, field order and behaviour; only where it renders changes:
//   remote-access, device-pairing, paired-devices   (Security, unchanged, first)
//   permissions        ← Models › 권한 (ModelsSettings.tsx: PermissionsFields)
//   grants             NEW (허용한 작업)
//   saved-keys         ← Models › 저장된 키 (ModelsSettings.tsx: SavedKeysRows)
//   diagnostics        ← Privacy › 진단 (PrivacySettings.tsx; the Privacy page is removed)
//   security-advanced + allowed-hosts                (Security, unchanged, last)
// The gateway answers /security only on this computer; on another computer only the remote
// access section collapses to its message, the moved sections still render (they never did
// depend on /security).

function MovedSections({ grants }: { grants: ReactNode }) {
  const savedKeys = useSavedKeys();
  const draft = useSettingsUIStore((state) => state.draft);
  const update = useSettingsUIStore((state) => state.update);
  const setSettings = useButlerStore((state) => state.setSettings);
  const settingsCopy = appCopy.settings;
  const sections = settingsCopy.pageSections;
  return (
    <>
      <SettingsSection id="permissions" kind="form" title={sections.permissions}>
        <PermissionsFields />
      </SettingsSection>
      {grants}
      {savedKeys.state !== "unsupported" && (
        <SettingsSection
          id="saved-keys"
          kind="list"
          title={sections.savedKeys}
          state={savedKeys.state === "ready" && savedKeys.credentials.length === 0 ? "empty" : savedKeys.state}
          emptyMessage={settingsCopy.savedKeys.empty}
          onRetry={() => void savedKeys.reload()}
        >
          <SavedKeysRows keys={savedKeys} />
        </SettingsSection>
      )}
      {draft ? (
        <SettingsSection id="diagnostics" kind="form" title={sections.diagnostics}>
          <SettingsSwitch
            settingId="diagnostics"
            label={settingsCopy.fields.diagnostics}
            checked={draft.diagnostics_enabled}
            onChange={(value) => update({ diagnostics_enabled: value }, setSettings)}
          />
        </SettingsSection>
      ) : null}
    </>
  );
}

export function SecurityPageProposal({ grants }: { grants: ReactNode }) {
  useAppLocale();
  const security = useSecuritySettings();
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const settingsCopy = appCopy.settings;
  const sections = settingsCopy.pageSections;
  const { view, load, busy } = security;
  const refused = load === "host-only" || load === "admin-required" || load === "error";
  return (
    <SettingsPage>
      {refused ? (
        <SettingsSection
          id="remote-access"
          kind="form"
          title={sections.remoteAccess}
          state={load === "host-only" ? "empty" : "error"}
          emptyMessage={settingsCopy.security.hostOnly}
          errorMessage={load === "admin-required" ? settingsCopy.security.adminRequired : undefined}
          onRetry={security.retry}
        />
      ) : (
        <SettingsSection id="remote-access" kind="form" title={sections.remoteAccess} state={view ? "ready" : "loading"}>
          {view && (
            <SecurityRemoteAccessFields view={view} disabled={busy !== null}
              onChange={(enabled) => void security.toggleRemoteAccess(enabled)} />
          )}
        </SettingsSection>
      )}
      {!refused && view?.remote_access_enabled && (
        <>
          <SecurityPairingSection disabled={busy !== null} />
          <SecurityDevicesSection disabled={busy !== null} />
        </>
      )}
      <MovedSections grants={grants} />
      {!refused && view && (
        <SettingsSection id="security-advanced" kind="form" title={settingsCopy.security.advanced}>
          <DisclosureRow surface="plain" data-test-class="settings-security-advanced"
            title={settingsCopy.security.advancedContents} open={advancedOpen} onToggle={() => setAdvancedOpen(!advancedOpen)} />
        </SettingsSection>
      )}
      {!refused && view && advancedOpen && (
        <SettingsSection id="allowed-hosts" kind="form" title={sections.allowedHosts}>
          <SecurityAllowedHostsField hosts={view.allowed_hosts} disabled={busy !== null} onSave={security.saveAllowedHosts} />
        </SettingsSection>
      )}
    </SettingsPage>
  );
}
