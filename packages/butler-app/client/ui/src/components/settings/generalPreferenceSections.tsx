// Direct sections keep SettingsPage's composition contract and localize each preference group.
import { appCopy } from "@/app/copy.ts";
import type { SettingsView as SettingsData } from "@/app/types.ts";
import type { useButlerStore } from "@/app/store.ts";
import type { useSettingsUIStore } from "@/stores/settingsUIStore.ts";
import { SettingsSection, SettingsSelect, SettingsSwitch } from "./SettingsFormComponents";
import { SettingsSearchableSelect } from "./SettingsSearchableSelect";
import { NativeNotificationStatusPanel } from "./NativeNotificationStatusPanel";

type Update = ReturnType<typeof useSettingsUIStore.getState>["update"];
type SetSettings = ReturnType<typeof useButlerStore.getState>["setSettings"];
type Region = Pick<SettingsData, "language" | "timezone">;

export function languageRegionSection(draft: Region, timezones: { value: string; label: string }[], update: Update, setSettings: SetSettings) {
  const { fields, descriptions, options, pageSections: sections } = appCopy.settings;
  return (
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
          options={timezones}
          searchLabel={options.timezoneSearch}
          searchPlaceholder={options.timezoneSearch}
          searchClearLabel={options.timezoneSearchClear}
          allLabel={options.timezoneAll}
          emptyLabel={options.timezoneEmpty}
        />
      </SettingsSection>
  );
}

export function notificationSections(notifications: SettingsData["desktop_notifications"], updateNotifications: (partial: Partial<SettingsData["desktop_notifications"]>) => void) {
  const { fields, descriptions, pageSections: sections, pageSectionDescriptions: sectionDescriptions } = appCopy.settings;
  return <>
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
  </>;
}
