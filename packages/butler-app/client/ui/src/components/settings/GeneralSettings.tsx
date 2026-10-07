import { memo, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { DEFAULT_WEB_SEARCH_SETTINGS } from "@/app/constants.ts";
import { StartAtLoginField } from "./StartAtLoginField";
import { useAppLocale } from "@/app/copy.ts";
import { appCopy } from "@/app/copy.ts";
import { ConversationInputFields } from "./ConversationInputFields";
import { useButlerStore } from "@/app/store.ts";
import { useSettingsUIStore } from "@/stores/settingsUIStore.ts";
import type { SettingsView as SettingsData } from "@/app/types.ts";
import { SettingsPage, SettingsSection, SettingsSwitch } from "./SettingsFormComponents";
import { languageRegionSection, notificationSections } from "./generalPreferenceSections";
import { MemoryModelPreparation } from "./MemoryModelPreparation";
import { RerunSetupField } from "./RerunSetupField";
import { SearchBehaviorFields, SearchProviderFields } from "./SearchSettings";

export const GeneralSettings = memo(function GeneralSettings() {
  useAppLocale();
  const draft = useSettingsUIStore(useShallow((state) => state.draft && ({
    language: state.draft.language, timezone: state.draft.timezone,
    desktop_notifications: state.draft.desktop_notifications,
    desktop_tray_enabled: state.draft.desktop_tray_enabled,
  })));
  const webSearch = useSettingsUIStore(useShallow((state) => state.draft?.web_search ?? DEFAULT_WEB_SEARCH_SETTINGS));
  const searchDraft = useMemo(() => ({ web_search: webSearch }), [webSearch]);
  const timezones = useMemo(timezoneOptions, []);
  const update = useSettingsUIStore((state) => state.update);
  const setSettings = useButlerStore((state) => state.setSettings);

  const settingsCopy = appCopy.settings;
  const fields = settingsCopy.fields;
  const descriptions = settingsCopy.descriptions;
  const sections = settingsCopy.pageSections;
  const sectionDescriptions = settingsCopy.pageSectionDescriptions;

  if (!draft) return null;
  const notifications = draft.desktop_notifications;
  const updateNotifications = (partial: Partial<SettingsData["desktop_notifications"]>) =>
    update({ desktop_notifications: { ...notifications, ...partial } }, setSettings);

  return (
    <SettingsPage>
      {languageRegionSection(draft, timezones, update, setSettings)}
      <SettingsSection id="conversation-input" kind="form" title={sections.conversationInput}>
        <ConversationInputFields />
      </SettingsSection>
      {notificationSections(draft.desktop_notifications, updateNotifications)}
      <SettingsSection id="memory-model" kind="status" title={appCopy.firstRun.memoryModel.label}>
        <MemoryModelPreparation />
      </SettingsSection>
      <SettingsSection id="app-behavior" kind="form" title={sections.appBehavior}>
        <SettingsSwitch
          settingId="desktop-tray"
          label={fields.desktopTray}
          description={descriptions.desktopTray}
          checked={draft.desktop_tray_enabled}
          onChange={(desktopTrayEnabled) => update({ desktop_tray_enabled: desktopTrayEnabled }, setSettings)}
        />
        <StartAtLoginField />
        <RerunSetupField />
      </SettingsSection>
      <SettingsSection
        id="search-provider"
        kind="form"
        title={sections.searchProvider}
        description={sectionDescriptions.searchProvider}
      >
        <SearchProviderFields draft={searchDraft} />
      </SettingsSection>
      <SettingsSection
        id="search-behavior"
        kind="form"
        title={sections.searchBehavior}
        description={sectionDescriptions.searchBehavior}
      >
        <SearchBehaviorFields draft={searchDraft} />
      </SettingsSection>
    </SettingsPage>
  );
});

function timezoneOptions(): Array<{ value: string; label: string }> {
  const fallback = ["UTC", "Asia/Seoul", "America/Los_Angeles", "America/New_York", "Europe/London", "Europe/Paris"];
  const timezones = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : fallback;
  return [...new Set(["UTC", ...timezones])].map((timezone) => ({
    value: timezone,
    label: timezone.replace(/_/gu, " "),
  }));
}
