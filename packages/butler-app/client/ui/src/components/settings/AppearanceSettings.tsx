import { appCopy } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";
import { useSettingsUIStore } from "@/stores/settingsUIStore.ts";
import { Button, ButtonContainer } from "@/butler-ds";
import { Sun, Moon, Monitor } from "@/butler-ds";
import {
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
} from "./SettingsFormComponents";
import type { SettingsView as SettingsData } from "@/app/types.ts";
import { MainScreenThemeSettings } from "./MainScreenThemeSettings";

export function AppearanceSettings() {
  const draft = useSettingsUIStore((state) => state.draft);
  const update = useSettingsUIStore((state) => state.update);
  const saving = useSettingsUIStore((state) => state.saving);
  const setSettings = useButlerStore((state) => state.setSettings);

  const settingsCopy = appCopy.settings;
  const settingsFields = settingsCopy.fields;
  const settingsOptions = settingsCopy.options;

  if (!draft) return null;

  return (
    <SettingsSection title={settingsCopy.sections.appearance}>
      <SettingsSelect
        label={settingsFields.theme}
        value={draft.appearance_theme}
        onChange={(value) =>
          update(
            {
              appearance_theme: value as SettingsData["appearance_theme"],
            },
            setSettings,
          )
        }
        options={[
          { value: "system", label: settingsOptions.system },
          { value: "light", label: settingsOptions.light },
          { value: "dark", label: settingsOptions.dark },
        ]}
      />
      <ButtonContainer size="default" aria-label={settingsFields.themeSamples}>
        <Button
          type="button"
          variant="outline"
          disabled={saving}
          onClick={() => update({ appearance_theme: "light" }, setSettings)}
        >
          <Sun size={15} /> {settingsOptions.light}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={saving}
          onClick={() => update({ appearance_theme: "dark" }, setSettings)}
        >
          <Moon size={15} /> {settingsOptions.dark}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={saving}
          onClick={() => update({ appearance_theme: "system" }, setSettings)}
        >
          <Monitor size={15} /> {settingsOptions.system}
        </Button>
      </ButtonContainer>
      <MainScreenThemeSettings />
      <SettingsSwitch
        label={settingsFields.translucentSidebar}
        checked={draft.translucent_sidebar}
        onChange={(value) =>
          update({ translucent_sidebar: value }, setSettings)
        }
      />
    </SettingsSection>
  );
}
