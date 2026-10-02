import { useState } from "react";
import { api } from "@/app/api.ts";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import { notifyError } from "@/app/notifications.ts";
import { useButlerStore } from "@/app/store.ts";
import type { SettingsView } from "@/app/types.ts";
import { SettingsSection } from "./SettingsFormComponents";
import { SettingsSwitch } from "./SettingsSwitch";

export function UpdatePreviewSwitch({ disabled, onChanged }: {
  disabled: boolean;
  onChanged: () => Promise<void>;
}) {
  useAppLocale();
  const settings = useButlerStore(state => state.settings);
  const setSettings = useButlerStore(state => state.setSettings);
  const [saving, setSaving] = useState(false);
  async function change(enabled: boolean) {
    setSaving(true);
    try {
      const next = await api<SettingsView>("/settings", {
        method: "PATCH", body: JSON.stringify({ update_previews: enabled }),
      });
      setSettings(next);
      await onChanged();
    } catch (error) {
      notifyError(error, appCopy.settings.errors.applyUpdate);
    } finally {
      setSaving(false);
    }
  }
  return (
    <SettingsSection id="update-channel" kind="form">
      <SettingsSwitch settingId="update-previews"
        label={appCopy.settings.actions.receivePreviewVersions}
        description={appCopy.settings.actions.receivePreviewVersionsDescription}
        checked={settings?.update_previews ?? false} disabled={disabled || saving}
        onChange={enabled => void change(enabled)} />
    </SettingsSection>
  );
}
