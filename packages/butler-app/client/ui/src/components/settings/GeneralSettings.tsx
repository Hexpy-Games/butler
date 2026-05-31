import { appCopy } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";
import { useSettingsUIStore } from "@/stores/settingsUIStore.ts";
import type { SettingsView as SettingsData } from "@/app/types.ts";
import { SettingsSection, SettingsSelect } from "./SettingsFormComponents";
import { DesktopShellSettings } from "./DesktopShellSettings";
import { SettingsSearchableSelect } from "./SettingsSearchableSelect";
import { SearchSettings } from "./SearchSettings";

export function GeneralSettings() {
  const draft = useSettingsUIStore((state) => state.draft);
  const update = useSettingsUIStore((state) => state.update);
  const setSettings = useButlerStore((state) => state.setSettings);

  const settingsCopy = appCopy.settings;
  const settingsFields = settingsCopy.fields;
  const settingsDescriptions = settingsCopy.descriptions;
  const settingsOptions = settingsCopy.options;

  if (!draft) return null;

  return (
    <>
      <SettingsSection title={settingsCopy.sections.general}>
        <SettingsSelect
          label={settingsFields.language}
          description={settingsDescriptions.language}
          value={draft.language}
          onChange={(value) =>
            update({ language: value as SettingsData["language"] }, setSettings)
          }
          options={[
            { value: "en", label: settingsOptions.english },
            { value: "ko", label: settingsOptions.korean },
          ]}
        />
        <SettingsSearchableSelect
          label={settingsFields.timezone}
          description={settingsDescriptions.timezone}
          value={draft.timezone}
          onChange={(value) => update({ timezone: value }, setSettings)}
          options={timezoneOptions()}
          searchLabel={settingsOptions.timezoneSearch}
          searchPlaceholder={settingsOptions.timezoneSearch}
          searchClearLabel={settingsOptions.timezoneSearchClear}
          allLabel={settingsOptions.timezoneAll}
          emptyLabel={settingsOptions.timezoneEmpty}
        />
        <SettingsSelect
          label={settingsFields.followUpBehavior}
          value={draft.follow_up_behavior}
          onChange={(value) =>
            update(
              {
                follow_up_behavior: value as SettingsData["follow_up_behavior"],
              },
              setSettings,
            )
          }
          options={[
            { value: "queue", label: settingsOptions.queueWhileBusy },
            { value: "steer", label: settingsOptions.steerCurrentTurn },
          ]}
        />
        <SettingsSelect
          label={settingsFields.multilineSend}
          value={draft.multiline_send_behavior}
          onChange={(value) =>
            update(
              {
                multiline_send_behavior:
                  value as SettingsData["multiline_send_behavior"],
              },
              setSettings,
            )
          }
          options={[
            {
              value: "modifier_enter_send_enter_newline",
              label: settingsOptions.modifierEnterSendEnterNewline,
            },
            {
              value: "enter_send_shift_enter_newline",
              label: settingsOptions.enterSendShiftEnterNewline,
            },
          ]}
        />
      </SettingsSection>
      <DesktopShellSettings draft={draft} />
      <SearchSettings draft={draft} />
    </>
  );
}

function timezoneOptions(): Array<{ value: string; label: string }> {
  const fallback = [
    "UTC",
    "Asia/Seoul",
    "America/Los_Angeles",
    "America/New_York",
    "Europe/London",
    "Europe/Paris",
  ];
  const timezones =
    typeof Intl.supportedValuesOf === "function"
      ? Intl.supportedValuesOf("timeZone")
      : fallback;
  return [...new Set(["UTC", ...timezones])].map((timezone) => ({
    value: timezone,
    label: timezone.replace(/_/gu, " "),
  }));
}
