import { memo } from "react";
import { useShallow } from "zustand/react/shallow";
import { useAppLocale } from "@/app/copy.ts";
import { appCopy } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";
import { useAppearanceOverrideStore } from "@/stores/appearanceStore.ts";
import { useSettingsUIStore } from "@/stores/settingsUIStore.ts";
import {
  SettingsPage,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
} from "./SettingsFormComponents";
import type { SettingsView as SettingsData } from "@/app/types.ts";
import { ReduceMotionField } from "./ReduceMotionField";
import { MainScreenThemeSettings } from "./MainScreenThemeSettings";

export const AppearanceSettings = memo(function AppearanceSettings() {
  useAppLocale();
  const draft = useSettingsUIStore(useShallow((state) => state.draft && ({
    appearance_theme: state.draft.appearance_theme,
    translucent_sidebar: state.draft.translucent_sidebar,
    smart_grouping_enabled: state.draft.smart_grouping_enabled,
  })));
  const update = useSettingsUIStore((state) => state.update);
  const setSettings = useButlerStore((state) => state.setSettings);
  // A real-time wallpaper sets light/dark itself while it is on.
  const wallpaperSetsTheme = useAppearanceOverrideStore((state) => state.sceneTone !== null);

  const settingsCopy = appCopy.settings;
  const fields = settingsCopy.fields;
  const options = settingsCopy.options;
  const sections = settingsCopy.pageSections;

  if (!draft) return null;

  return (
    <SettingsPage>
      <SettingsSection id="theme" kind="form" title={sections.theme}>
        <SettingsSelect
          settingId="theme"
          label={fields.theme}
          value={draft.appearance_theme}
          disabledReason={wallpaperSetsTheme ? settingsCopy.descriptions.themeFollowsWallpaper : undefined}
          onChange={(value) =>
            update({ appearance_theme: value as SettingsData["appearance_theme"] }, setSettings)}
          options={[
            { value: "system", label: options.system },
            { value: "light", label: options.light },
            { value: "dark", label: options.dark },
          ]}
        />
        <SettingsSwitch
          settingId="translucent-sidebar"
          label={fields.translucentSidebar}
          checked={draft.translucent_sidebar}
          onChange={(value) => update({ translucent_sidebar: value }, setSettings)}
        />
      </SettingsSection>
      <SettingsSection
        id="sidebar"
        kind="form"
        title={sections.sidebar}
        description={settingsCopy.pageSectionDescriptions.sidebar}
      >
        <SettingsSwitch
          settingId="smart-groups"
          label={appCopy.interfaceDetails.smartGroups}
          description={appCopy.interfaceDetails.smartGroupsDescription}
          checked={draft.smart_grouping_enabled}
          onChange={(value) => update({ smart_grouping_enabled: value }, setSettings)}
        />
      </SettingsSection>
      <SettingsSection
        id="home-screen"
        kind="form"
        title={sections.homeScreen}
        description={settingsCopy.pageSectionDescriptions.homeScreen}
      >
        <MainScreenThemeSettings />
      </SettingsSection>
      <SettingsSection id="accessibility" kind="form" title={sections.accessibility}>
        <ReduceMotionField />
      </SettingsSection>
    </SettingsPage>
  );
});
