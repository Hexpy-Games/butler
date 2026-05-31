import { appCopy } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";
import type { SettingsView as SettingsData } from "@/app/types.ts";
import { useSettingsUIStore } from "@/stores/settingsUIStore.ts";
import { SettingsSection, SettingsSwitch } from "./SettingsFormComponents";
import { NativeNotificationStatusPanel } from "./NativeNotificationStatusPanel";

export function DesktopShellSettings({ draft }: { draft: SettingsData }) {
  const update = useSettingsUIStore((state) => state.update);
  const setSettings = useButlerStore((state) => state.setSettings);
  const settingsFields = appCopy.settings.fields;
  const settingsDescriptions = appCopy.settings.descriptions;
  const settingsSections = appCopy.settings.sections;

  return (
    <>
      <SettingsSection title={settingsSections.notifications}>
        <SettingsSwitch
          label={settingsFields.desktopNotifications}
          description={settingsDescriptions.desktopNotifications}
          checked={draft.desktop_notifications.enabled}
          onChange={(enabled) =>
            update(
              {
                desktop_notifications: {
                  ...draft.desktop_notifications,
                  enabled,
                },
              },
              setSettings,
            )
          }
        />
        <SettingsSwitch
          label={settingsFields.desktopNotificationAssistantMessages}
          description={settingsDescriptions.desktopNotificationAssistantMessages}
          checked={draft.desktop_notifications.assistant_messages}
          onChange={(assistantMessages) =>
            update(
              {
                desktop_notifications: {
                  ...draft.desktop_notifications,
                  assistant_messages: assistantMessages,
                },
              },
              setSettings,
            )
          }
        />
        <SettingsSwitch
          label={settingsFields.desktopNotificationTaskCompletions}
          description={settingsDescriptions.desktopNotificationTaskCompletions}
          checked={draft.desktop_notifications.task_completions}
          onChange={(taskCompletions) =>
            update(
              {
                desktop_notifications: {
                  ...draft.desktop_notifications,
                  task_completions: taskCompletions,
                },
              },
              setSettings,
            )
          }
        />
        <NativeNotificationStatusPanel />
      </SettingsSection>
      <SettingsSection title={settingsSections.desktopShell}>
        <SettingsSwitch
          label={settingsFields.desktopTray}
          description={settingsDescriptions.desktopTray}
          checked={draft.desktop_tray_enabled}
          onChange={(desktopTrayEnabled) =>
            update({ desktop_tray_enabled: desktopTrayEnabled }, setSettings)
          }
        />
      </SettingsSection>
    </>
  );
}
