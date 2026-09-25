import { useAppLocale } from "@/app/copy.ts";
import { appCopy } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";
import { useSettingsUIStore } from "@/stores/settingsUIStore.ts";
import {
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
} from "./SettingsFormComponents";
import type { SettingsView as SettingsData } from "@/app/types.ts";
import { MainScreenThemeSettings } from "./MainScreenThemeSettings";

export function AppearanceSettings() {
  useAppLocale();
  const draft = useSettingsUIStore((state) => state.draft);
  const update = useSettingsUIStore((state) => state.update);
  const setSettings = useButlerStore((state) => state.setSettings);

  const settingsCopy = appCopy.settings;
  const settingsFields = settingsCopy.fields;
  const settingsOptions = settingsCopy.options;

  if (!draft) return null;

  return (
    <SettingsSection>
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
