import { appCopy } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";
import { useSettingsUIStore } from "@/stores/settingsUIStore.ts";
import { SettingsSection, SettingsSwitch } from "./SettingsFormComponents";

export function PrivacySettings() {
  const draft = useSettingsUIStore((state) => state.draft);
  const update = useSettingsUIStore((state) => state.update);
  const setSettings = useButlerStore((state) => state.setSettings);

  const settingsCopy = appCopy.settings;
  const settingsFields = settingsCopy.fields;

  if (!draft) return null;

  return (
    <SettingsSection title={settingsCopy.panels.privacyDiagnostics}>
      <SettingsSwitch
        label={settingsFields.diagnostics}
        checked={draft.diagnostics_enabled}
        onChange={(value) => update({ diagnostics_enabled: value }, setSettings)}
      />
    </SettingsSection>
  );
}
