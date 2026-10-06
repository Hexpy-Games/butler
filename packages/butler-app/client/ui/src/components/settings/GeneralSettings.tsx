import { StartAtLoginField } from "./StartAtLoginField";
import { useAppLocale } from "@/app/copy.ts";
import { appCopy } from "@/app/copy.ts";
import { ConversationInputFields } from "./ConversationInputFields";
import { useButlerStore } from "@/app/store.ts";
import { useSettingsUIStore } from "@/stores/settingsUIStore.ts";
import type { SettingsView as SettingsData } from "@/app/types.ts";
import { SettingsPage, SettingsSection, SettingsSelect, SettingsSwitch } from "./SettingsFormComponents";
import { SettingsSearchableSelect } from "./SettingsSearchableSelect";
import { NativeNotificationStatusPanel } from "./NativeNotificationStatusPanel";
import { MemoryModelPreparation } from "./MemoryModelPreparation";
import { RerunSetupField } from "./RerunSetupField";
import { SearchBehaviorFields, SearchProviderFields } from "./SearchSettings";

export function GeneralSettings() {
  useAppLocale();
  const draft = useSettingsUIStore((state) => state.draft);
  const update = useSettingsUIStore((state) => state.update);
  const setSettings = useButlerStore((state) => state.setSettings);

  const settingsCopy = appCopy.settings;
  const fields = settingsCopy.fields;
  const descriptions = settingsCopy.descriptions;
  const options = settingsCopy.options;
  const sections = settingsCopy.pageSections;
  const sectionDescriptions = settingsCopy.pageSectionDescriptions;

  if (!draft) return null;
  const notifications = draft.desktop_notifications;
  const updateNotifications = (partial: Partial<SettingsData["desktop_notifications"]>) =>
    update({ desktop_notifications: { ...notifications, ...partial } }, setSettings);

  return (
    <SettingsPage>
      <SettingsSection id="language-region" kind="form" title={sections.languageRegion}>
        <SettingsSelect
          settingId="language"
          label={fields.language}
          description={descriptions.language}
          value={draft.language}
          onChange={(value) => update({ language: value as SettingsData["language"] }, setSettings)}
          options={[
            { value: "en", label: options.english },
            { value: "ko", label: options.korean },
          ]}
        />
        <SettingsSearchableSelect
          settingId="timezone"
          label={fields.timezone}
          description={descriptions.timezone}
          value={draft.timezone}
          onChange={(value) => update({ timezone: value }, setSettings)}
          options={timezoneOptions()}
          searchLabel={options.timezoneSearch}
          searchPlaceholder={options.timezoneSearch}
          searchClearLabel={options.timezoneSearchClear}
          allLabel={options.timezoneAll}
          emptyLabel={options.timezoneEmpty}
        />
      </SettingsSection>
      <SettingsSection id="conversation-input" kind="form" title={sections.conversationInput}>
        <ConversationInputFields />
      </SettingsSection>
      <SettingsSection id="notifications" kind="form" title={sections.notifications}>
        <SettingsSwitch
          settingId="desktop-notifications"
          label={fields.desktopNotifications}
          description={descriptions.desktopNotifications}
          checked={notifications.enabled}
          onChange={(enabled) => updateNotifications({ enabled })}
        />
        <SettingsSwitch
          settingId="notify-assistant-messages"
          label={fields.desktopNotificationAssistantMessages}
          description={descriptions.desktopNotificationAssistantMessages}
          checked={notifications.assistant_messages}
          onChange={(assistantMessages) => updateNotifications({ assistant_messages: assistantMessages })}
        />
        <SettingsSwitch
          settingId="notify-task-completions"
          label={fields.desktopNotificationTaskCompletions}
          description={descriptions.desktopNotificationTaskCompletions}
          checked={notifications.task_completions}
          onChange={(taskCompletions) => updateNotifications({ task_completions: taskCompletions })}
        />
      </SettingsSection>
      <SettingsSection
        id="notification-permission"
        kind="status"
        title={sections.notificationPermission}
        description={sectionDescriptions.notificationPermission}
      >
        <NativeNotificationStatusPanel />
      </SettingsSection>
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
        <SearchProviderFields draft={draft} />
      </SettingsSection>
      <SettingsSection
        id="search-behavior"
        kind="form"
        title={sections.searchBehavior}
        description={sectionDescriptions.searchBehavior}
      >
        <SearchBehaviorFields draft={draft} />
      </SettingsSection>
    </SettingsPage>
  );
}

function timezoneOptions(): Array<{ value: string; label: string }> {
  const fallback = ["UTC", "Asia/Seoul", "America/Los_Angeles", "America/New_York", "Europe/London", "Europe/Paris"];
  const timezones = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : fallback;
  return [...new Set(["UTC", ...timezones])].map((timezone) => ({
    value: timezone,
    label: timezone.replace(/_/gu, " "),
  }));
}
