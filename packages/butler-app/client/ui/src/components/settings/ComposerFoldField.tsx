import { useState } from "react";
import { appCopy } from "@/app/copy";
import { useButlerStore } from "@/app/store";
import { useSettingsUIStore } from "@/stores/settingsUIStore";
import { SettingsSwitch } from "./SettingsSwitch";

export function ComposerFoldField() {
  const saved = useSettingsUIStore((state) => state.draft?.collapse_message_box ?? true);
  const update = useSettingsUIStore((state) => state.update);
  const setSettings = useButlerStore((state) => state.setSettings);
  const [pending, setPending] = useState<boolean | null>(null);
  const copy = appCopy.settings;
  return (
    <SettingsSwitch
      settingId="collapse-message-box"
      label={copy.fields.collapseMessageBox}
      description={copy.descriptions.collapseMessageBox}
      checked={pending ?? saved}
      disabled={pending !== null}
      onChange={(value) => {
        if (value === saved) return;
        setPending(value);
        setSettings({ ...useButlerStore.getState().settings, collapse_message_box: value });
        void update({ collapse_message_box: value }, setSettings).finally(() => {
          setPending(null);
          const current = useSettingsUIStore.getState().baseline;
          if (current) setSettings(current);
        });
      }}
    />
  );
}
