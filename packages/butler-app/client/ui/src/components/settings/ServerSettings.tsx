import { useAppLocale } from "@/app/copy.ts";
import { appCopy } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";
import { useSettingsUIStore } from "@/stores/settingsUIStore.ts";
import { Button, FolderPlus, SettingsField } from "@/butler-ds";
import { SettingsSection, SettingsInput } from "./SettingsFormComponents";

export function ServerSettings() {
  useAppLocale();
  const draft = useSettingsUIStore((state) => state.draft);
  const setDraft = useSettingsUIStore((state) => state.setDraft);
  const update = useSettingsUIStore((state) => state.update);
  const chooseDefaultProjectFolder = useSettingsUIStore(
    (state) => state.chooseDefaultProjectFolder,
  );
  const setSettings = useButlerStore((state) => state.setSettings);

  const settingsCopy = appCopy.settings;
  const settingsFields = settingsCopy.fields;

  if (!draft) return null;

  return (
    <SettingsSection title={settingsCopy.panels.serverBridge}>
      <SettingsInput
        label={settingsFields.serverUrl}
        value={draft.server_url}
        onChange={(value) => setDraft({ ...draft, server_url: value })}
        onBlur={() => update({ server_url: draft.server_url }, setSettings)}
      />
      <SettingsField
        data-test-class="settings-field"
        label={settingsFields.defaultProjectFolder}
        description={draft.default_project_workspace_label}
        control={
          <Button
            type="button"
            variant="outline"
            onClick={() => chooseDefaultProjectFolder(setSettings)}
          >
            <FolderPlus size="md" /> {settingsCopy.actions.chooseFolder}
          </Button>
        }
      />
    </SettingsSection>
  );
}
