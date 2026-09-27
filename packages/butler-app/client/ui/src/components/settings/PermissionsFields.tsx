import { useAppLocale } from "@/app/copy.ts";
import { appCopy } from "@/app/copy.ts";
import type { SettingsView as SettingsData } from "@/app/types.ts";
import { SettingsSelect, SettingsSwitch } from "./SettingsFormComponents";
import { useButlerModels } from "./hooks/useButlerModels";

/** Permissions section: access mode and plan mode default. */
export function PermissionsFields() {
  useAppLocale();
  const { draft, update, setSettings } = useButlerModels();
  const fields = appCopy.settings.fields;
  if (!draft) return null;
  return (
    <>
      <SettingsSelect
        settingId="access-mode"
        label={fields.access}
        value={draft.access_mode}
        onChange={(value) => update({ access_mode: value as SettingsData["access_mode"] }, setSettings)}
        options={[
          { value: "full_access", label: appCopy.permissions.fullAccess },
          { value: "ask_first", label: appCopy.permissions.askFirst },
          { value: "read_only", label: appCopy.permissions.readOnly },
        ]}
      />
      <SettingsSwitch
        settingId="plan-mode-default"
        label={fields.planModeDefault}
        checked={draft.plan_mode_default}
        onChange={(value) => update({ plan_mode_default: value }, setSettings)}
      />
    </>
  );
}
