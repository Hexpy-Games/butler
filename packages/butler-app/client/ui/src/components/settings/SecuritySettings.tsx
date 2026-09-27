import { appCopy, useAppLocale } from "@/app/copy.ts";
import { SettingsPage, SettingsSection } from "./SettingsFormComponents";
import { SecurityConnectionCodeField } from "./SecurityConnectionCodeField";
import { SecurityRemoteAccessFields } from "./SecurityRemoteAccessFields";
import { useSecuritySettings } from "./useSecuritySettings";

/** Settings → Security: LAN access and the connection code (loopback clients only). */
export function SecuritySettings() {
  useAppLocale();
  const security = useSecuritySettings();
  const settingsCopy = appCopy.settings;
  const sections = settingsCopy.pageSections;
  const { view, load, busy } = security;

  if (load === "host-only" || load === "error") {
    return (
      <SettingsPage>
        <SettingsSection
          id="remote-access"
          kind="form"
          title={sections.remoteAccess}
          state={load === "error" ? "error" : "empty"}
          emptyMessage={settingsCopy.security.hostOnly}
          onRetry={security.retry}
        />
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
      <SettingsSection id="connection-code" kind="form" title={sections.connectionCode} state={state}>
        {view && (
          <SecurityConnectionCodeField
            code={view.connection_code}
            revealed={security.revealed}
            disabled={busy !== null}
            onReveal={() => void security.toggleReveal()}
            onCopy={() => void security.copyCode()}
            onRotate={() => void security.rotate()}
          />
        )}
      </SettingsSection>
    </SettingsPage>
  );
}
