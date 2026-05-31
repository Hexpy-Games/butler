import { appCopy } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";
import { useSettingsUIStore } from "@/stores/settingsUIStore.ts";
import { Button, Stack } from "@/butler-ds";
import { Field, FieldLabel } from "@/butler-ds";
import { FolderPlus } from "@/butler-ds";
import { SettingsSection, SettingsSelect, SettingsInput } from "./SettingsFormComponents";
import type { SettingsView as SettingsData } from "@/app/types.ts";

export function ServerSettings() {
  const draft = useSettingsUIStore((state) => state.draft);
  const setDraft = useSettingsUIStore((state) => state.setDraft);
  const update = useSettingsUIStore((state) => state.update);
  const chooseDefaultProjectFolder = useSettingsUIStore(
    (state) => state.chooseDefaultProjectFolder,
  );
  const setSettings = useButlerStore((state) => state.setSettings);

  const settingsCopy = appCopy.settings;
  const settingsFields = settingsCopy.fields;
  const settingsOptions = settingsCopy.options;

  if (!draft) return null;

  return (
    <SettingsSection title={settingsCopy.panels.serverBridge}>
      <SettingsSelect
        label={settingsFields.bridgeMode}
        value={draft.bridge_mode}
        onChange={(value) =>
          update({ bridge_mode: value as SettingsData["bridge_mode"] }, setSettings)
        }
        options={[
          { value: "local", label: settingsOptions.local },
          { value: "external", label: settingsOptions.external },
        ]}
      />
      <SettingsInput
        label={settingsFields.serverUrl}
        value={draft.server_url}
        onChange={(value) => setDraft({ ...draft, server_url: value })}
        onBlur={() => update({ server_url: draft.server_url }, setSettings)}
      />
      <Field
        data-test-class="settings-field"
      >
        <FieldLabel>{settingsFields.defaultProjectFolder}</FieldLabel>
        <Stack align="row" justify="between" cross="center" gap="md" wrap>
          <strong>{draft.default_project_workspace_label}</strong>
          <Button
            type="button"
            variant="outline"
            onClick={() => chooseDefaultProjectFolder(setSettings)}
          >
            <FolderPlus size={15} /> {settingsCopy.actions.chooseFolder}
          </Button>
        </Stack>
      </Field>
    </SettingsSection>
  );
}
