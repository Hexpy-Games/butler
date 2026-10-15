import { appCopy, useAppLocale } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";
import { useSettingsUIStore } from "@/stores/settingsUIStore.ts";
import { CHAT_ACCESS_FACTORY_DEFAULT } from "@/components/conversation/accessModeUtils";
import { AccessModeSettingsField } from "./AccessModeSettingsField";

/** Settings → General → Default permission: the access mode new chats start with. */
export function DefaultPermissionFields() {
  useAppLocale();
  const accessMode = useSettingsUIStore((state) => state.draft?.access_mode);
  const scheduleMode = useSettingsUIStore((state) => state.draft?.schedule_access_mode ?? "auto");
  const update = useSettingsUIStore((state) => state.update);
  const setSettings = useButlerStore((state) => state.setSettings);
  const { fields, descriptions } = appCopy.settings;
  if (!accessMode) return null;
  return (
    <>
    <AccessModeSettingsField
      settingId="access-mode"
      label={fields.chatAccess}
      description={descriptions.chatAccess}
      value={accessMode}
      factoryDefault={CHAT_ACCESS_FACTORY_DEFAULT}
      onChange={(mode) => update({ access_mode: mode }, setSettings)}
    />
    <AccessModeSettingsField
      settingId="schedule-access-mode"
      label={fields.scheduleAccess}
      description={descriptions.scheduleAccess}
      value={scheduleMode}
      factoryDefault="auto"
      onChange={(mode) => update({ schedule_access_mode: mode }, setSettings)}
    />
    </>
  );
}
