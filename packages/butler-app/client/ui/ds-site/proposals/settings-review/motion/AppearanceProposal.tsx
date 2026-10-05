import { appCopy, useAppLocale } from "@/app/copy";
import { useButlerStore } from "@/app/store";
import type { SettingsView as SettingsData } from "@/app/types";
import { SettingsPage, SettingsSection, SettingsSelect, SettingsSwitch } from "@/components/settings/SettingsFormComponents";
import { useAppearanceOverrideStore } from "@/stores/appearanceStore";
import { useSettingsUIStore } from "@/stores/settingsUIStore";
import { t } from "../proposedCopy";
import type { StageState } from "../state";
import { HomeScreenFieldsProposal } from "./HomeScreenFieldsProposal";
import { ReduceMotionField } from "./ReduceMotionField";

// PROPOSAL COPY of components/settings/AppearanceSettings.tsx: every section, field and order is
// kept; only the new Reduce motion field is added, in one of three places:
//   accessibility (A, recommended): its own section right after Home screen;
//   homeScreen (B): last field of Home screen, under the wallpaper Motion switches;
//   codex (C): between Theme and Translucent sidebar, as on origin/codex/reduce-motion.

export function AppearanceProposal({ state, patch }: { state: StageState; patch: (next: Partial<StageState>) => void }) {
  useAppLocale();
  const draft = useSettingsUIStore((store) => store.draft);
  const update = useSettingsUIStore((store) => store.update);
  const setSettings = useButlerStore((store) => store.setSettings);
  const wallpaperSetsTheme = useAppearanceOverrideStore((store) => store.sceneTone !== null);
  const settingsCopy = appCopy.settings;
  const { fields, options, pageSections: sections } = settingsCopy;
  if (!draft) return null;
  const reduced = state.motion !== "off";
  const field = (
    <ReduceMotionField locale={state.locale} state={state.motion}
      onChange={(on) => patch({ motion: on ? "on" : "off" })} />
  );
  return (
    <SettingsPage>
      <SettingsSection id="theme" kind="form" title={sections.theme}>
        <SettingsSelect
          settingId="theme"
          label={fields.theme}
          value={draft.appearance_theme}
          disabledReason={wallpaperSetsTheme ? settingsCopy.descriptions.themeFollowsWallpaper : undefined}
          onChange={(value) => update({ appearance_theme: value as SettingsData["appearance_theme"] }, setSettings)}
          options={[
            { value: "system", label: options.system },
            { value: "light", label: options.light },
            { value: "dark", label: options.dark },
          ]}
        />
        {state.motionVariant === "codex" ? field : null}
        <SettingsSwitch
          settingId="translucent-sidebar"
          label={fields.translucentSidebar}
          checked={draft.translucent_sidebar}
          onChange={(value) => update({ translucent_sidebar: value }, setSettings)}
        />
      </SettingsSection>
      <SettingsSection id="sidebar" kind="form" title={sections.sidebar} description={settingsCopy.pageSectionDescriptions.sidebar}>
        <SettingsSwitch
          settingId="smart-groups"
          label={appCopy.interfaceDetails.smartGroups}
          description={appCopy.interfaceDetails.smartGroupsDescription}
          checked={draft.smart_grouping_enabled}
          onChange={(value) => update({ smart_grouping_enabled: value }, setSettings)}
        />
      </SettingsSection>
      <SettingsSection id="home-screen" kind="form" title={sections.homeScreen} description={settingsCopy.pageSectionDescriptions.homeScreen}>
        <HomeScreenFieldsProposal locale={state.locale} reduced={reduced}
          after={state.motionVariant === "homeScreen" ? field : undefined} />
      </SettingsSection>
      {state.motionVariant === "accessibility" ? (
        <SettingsSection id="accessibility" kind="form" title={t(state.locale, "settings.pageSections.accessibility")}>
          {field}
        </SettingsSection>
      ) : null}
    </SettingsPage>
  );
}
