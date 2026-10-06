import { readUiCrashLog } from "@/app/uiCrashReporting.ts";
import { notifyStatus } from "@/app/notifications.ts";
import { Button } from "@/butler-ds";
import { useAppLocale } from "@/app/copy.ts";
import { appCopy } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";
import { useSettingsUIStore } from "@/stores/settingsUIStore.ts";
import { SettingsPage, SettingsSection, SettingsSwitch } from "./SettingsFormComponents";

export function PrivacySettings() {
  useAppLocale();
  const draft = useSettingsUIStore((state) => state.draft);
  const update = useSettingsUIStore((state) => state.update);
  const setSettings = useButlerStore((state) => state.setSettings);

  const settingsCopy = appCopy.settings;
  const settingsFields = settingsCopy.fields;

  if (!draft) return null;

  return (
    <SettingsPage>
      <SettingsSection id="diagnostics" kind="form" title={settingsCopy.pageSections.diagnostics}>
        <Button size="sm" variant="outline" onClick={() => void copyDiagnostics()}>
          {appCopy.interfacePanels.copyDiagnostics}
        </Button>
        <SettingsSwitch
          settingId="diagnostics"
          label={settingsFields.diagnostics}
          checked={draft.diagnostics_enabled}
          onChange={(value) => update({ diagnostics_enabled: value }, setSettings)}
        />
      </SettingsSection>
    </SettingsPage>
  );
}

async function copyDiagnostics(): Promise<void> {
  try {
    await navigator.clipboard.writeText(JSON.stringify({ ui_crashes: await readUiCrashLog() }, null, 2));
    notifyStatus(appCopy.firstRun.reportCopied, { id: "ui-crash-export", tone: "ok" });
  } catch {
    notifyStatus(appCopy.firstRun.reportUnavailable, { id: "ui-crash-export", tone: "error" });
  }
}
