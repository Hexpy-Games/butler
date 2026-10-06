import { readUiCrashLog } from "@/app/uiCrashReporting.ts";
import { notifyStatus } from "@/app/notifications.ts";
import { Button } from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import type { SettingsView as SettingsData } from "@/app/types.ts";
import { SettingsSection, SettingsSelect, SettingsSwitch } from "./SettingsFormComponents";
import { useButlerModels } from "./hooks/useButlerModels";
import { useSavedKeys } from "./hooks/useSavedKeys";
import { SavedKeysRows } from "./SavedKeysRows";
import { GrantsSection } from "./GrantsSection";
import { useGrants } from "./useGrants";

/** Direct section elements for SettingsPage; data and effects stay with the page. */
export function securityAuthoritySections({ models, savedKeys, grants }: {
  models: Pick<ReturnType<typeof useButlerModels>, "update" | "setSettings"> & { draft: Pick<SettingsData, "access_mode" | "diagnostics_enabled"> | null }; savedKeys: ReturnType<typeof useSavedKeys>; grants: ReturnType<typeof useGrants>;
}) {
  const { draft, update, setSettings } = models;
  const settingsCopy = appCopy.settings;
  const fields = settingsCopy.fields;
  const sections = settingsCopy.pageSections;
  return <>
    <SettingsSection id="permissions" kind="form" title={sections.permissions}>
      {draft && <SettingsSelect
        settingId="access-mode"
        label={fields.access}
        value={draft.access_mode}
        onChange={(value) => update({ access_mode: value as SettingsData["access_mode"] }, setSettings)}
        options={[
          { value: "full_access", label: appCopy.permissions.fullAccess },
          { value: "ask_first", label: appCopy.permissions.askFirst },
          { value: "read_only", label: appCopy.permissions.readOnly },
        ]}
      />}
    </SettingsSection>
    <SettingsSection id="grants" kind="list" title={sections.grants}
      description={settingsCopy.pageSectionDescriptions.grants}
      state={grants.state === "ready" && grants.rows.length === 0 ? "empty" : grants.state}
      emptyMessage={settingsCopy.grants.empty} errorMessage={settingsCopy.grants.loadFailed} onRetry={() => void grants.reload()}>
      <GrantsSection grants={grants} />
    </SettingsSection>
    {savedKeys.state !== "unsupported" && (
      <SettingsSection id="saved-keys" kind="list" title={sections.savedKeys}
        state={savedKeys.state === "ready" && savedKeys.credentials.length === 0 ? "empty" : savedKeys.state}
        emptyMessage={settingsCopy.savedKeys.empty} onRetry={() => void savedKeys.reload()}>
        <SavedKeysRows keys={savedKeys} />
      </SettingsSection>
    )}
    {draft && <>
      <SettingsSection id="diagnostics" kind="form" title={settingsCopy.pageSections.diagnostics}>
        <Button size="sm" variant="outline" onClick={() => void copyDiagnostics()}>
          {appCopy.interfacePanels.copyDiagnostics}
        </Button>
        <SettingsSwitch
          settingId="diagnostics"
          label={fields.diagnostics}
          checked={draft.diagnostics_enabled}
          onChange={(value) => update({ diagnostics_enabled: value }, setSettings)}
        />
      </SettingsSection>
    </>}
  </>;
}

async function copyDiagnostics(): Promise<void> {
  try {
    await navigator.clipboard.writeText(JSON.stringify({ ui_crashes: await readUiCrashLog() }, null, 2));
    notifyStatus(appCopy.firstRun.reportCopied, { id: "ui-crash-export", tone: "ok" });
  } catch {
    notifyStatus(appCopy.firstRun.reportUnavailable, { id: "ui-crash-export", tone: "error" });
  }
}
