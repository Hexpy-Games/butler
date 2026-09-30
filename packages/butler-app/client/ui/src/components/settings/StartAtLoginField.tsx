import { useEffect, useState } from "react";
import { appCopy } from "@/app/copy";
import { getLoginSettings, setLoginSettings } from "@/app/loginSettings";
import { notifyError } from "@/app/notifications";
import { SettingsSwitch } from "./SettingsSwitch";

export function StartAtLoginField() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void getLoginSettings().then((settings) => {
      if (!cancelled && settings) setEnabled(settings.openAtLogin);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);
  if (enabled === null) return null;
  return <SettingsSwitch settingId="start-at-login" label={appCopy.automations.startAtLogin}
    checked={enabled} disabled={saving} onChange={(openAtLogin) => {
      setSaving(true);
      void setLoginSettings(openAtLogin).then((settings) => {
        if (settings) setEnabled(settings.openAtLogin);
      }).catch((error) => notifyError(error, appCopy.automations.loginFailed))
        .finally(() => setSaving(false));
    }} />;
}
