import { appCopy, useAppLocale } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";
import { useSettingsUIStore } from "@/stores/settingsUIStore.ts";
import { SettingsSwitch } from "./SettingsSwitch";

export function CommandSandboxField() {
  useAppLocale();
  const sandboxEnabled = useSettingsUIStore((state) => state.draft?.command_sandbox_enabled ?? true);
  const sandboxAvailable = useSettingsUIStore((state) => state.draft?.command_sandbox_available === true);
  const update = useSettingsUIStore((state) => state.update);
  const setSettings = useButlerStore((state) => state.setSettings);
  const { fields, descriptions } = appCopy.settings;
  return (
    <SettingsSwitch
      settingId="command-sandbox"
      label={fields.commandSandbox}
      description={descriptions.commandSandbox}
      checked={sandboxEnabled && sandboxAvailable}
      disabled={!sandboxAvailable}
      disabledReason={!sandboxAvailable ? descriptions.commandSandboxUnavailable : undefined}
      onChange={(value) => update({ command_sandbox_enabled: value }, setSettings)}
    />
  );
}
