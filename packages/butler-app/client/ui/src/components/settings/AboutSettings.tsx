import { useEffect, useId, useState, type CSSProperties } from "react";
import { api, setDeveloperMode } from "@/app/api.ts";
import { appCopy } from "@/app/copy.ts";
import { notifyError, notifyStatus } from "@/app/notifications.ts";
import { useButlerStore } from "@/app/store.ts";
import type { AppInfoView, SettingsView } from "@/app/types.ts";
import { SettingsField, Switch, Typo } from "@/butler-ds";
import { SettingsSection } from "./SettingsFormComponents";

const readOnlyValueStyle: CSSProperties = {
  color: "var(--text-primary)",
  overflowWrap: "anywhere",
};

export function AboutSettings() {
  const [info, setInfo] = useState<AppInfoView | null>(null);
  const [saving, setSaving] = useState(false);
  const setSettings = useButlerStore((state) => state.setSettings);
  const settingsCopy = appCopy.settings;
  const developerModeDescriptionId = useId();

  useEffect(() => {
    let cancelled = false;
    async function loadAppInfo() {
      try {
        const result = await api<AppInfoView>("/app-info");
        if (!cancelled) setInfo(result);
      } catch (error) {
        if (!cancelled) {
          notifyError(error, settingsCopy.errors.loadAppInfo, {
            id: "app-info",
          });
        }
      }
    }
    loadAppInfo();
    return () => {
      cancelled = true;
    };
  }, [settingsCopy.errors.loadAppInfo]);

  async function updateDeveloperMode(enabled: boolean) {
    setSaving(true);
    let nativeApplied = false;
    try {
      await setDeveloperMode(enabled);
      nativeApplied = true;
      const updatedSettings = await api<SettingsView>("/settings", {
        method: "PATCH",
        body: JSON.stringify({ diagnostics_enabled: enabled }),
      });
      const refreshedInfo = await api<AppInfoView>("/app-info");
      setInfo(refreshedInfo);
      setSettings(updatedSettings);
      notifyStatus(settingsCopy.saved, {
        id: "developer-mode",
        tone: "ok",
      });
    } catch (error) {
      if (nativeApplied) {
        try {
          const rolledBackInfo = await setDeveloperMode(!enabled);
          setInfo(rolledBackInfo);
        } catch {
          const refreshedInfo = await api<AppInfoView>("/app-info").catch(() => null);
          if (refreshedInfo) setInfo(refreshedInfo);
        }
      }
      notifyError(error, settingsCopy.errors.updateDeveloperMode, {
        id: "developer-mode",
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <SettingsSection title={settingsCopy.panels.about}>
      <SettingsField
        label={settingsCopy.fields.appName}
        control={readOnlyValue(info?.name ?? "Butler")}
        data-test-class="about-app-name"
      />
      <SettingsField
        label={settingsCopy.fields.appVersion}
        control={readOnlyValue(info?.version ?? "-")}
        data-test-class="about-app-version"
      />
      <SettingsField
        label={settingsCopy.fields.appRepository}
        control={
          info?.repository_url ? (
            <Typo.Body as="span" style={readOnlyValueStyle}>
              <a href={info.repository_url}>{info.repository_url}</a>
            </Typo.Body>
          ) : (
            readOnlyValue("-")
          )
        }
        controlWidth="full"
        data-test-class="about-app-repository"
      />
      <SettingsField
        label={settingsCopy.fields.appProtocol}
        control={readOnlyValue(info?.protocol_version ?? "-")}
        data-test-class="about-app-protocol"
      />
      <SettingsField
        id="about-developer-mode"
        label={settingsCopy.fields.developerMode}
        description={settingsCopy.descriptions.developerMode}
        descriptionId={developerModeDescriptionId}
        control={
          <Switch
            id="about-developer-mode"
            aria-describedby={developerModeDescriptionId}
            checked={info?.developer_mode_enabled ?? false}
            disabled={!info?.developer_mode_available || saving}
            onCheckedChange={updateDeveloperMode}
          />
        }
        data-test-class="about-developer-mode"
      />
    </SettingsSection>
  );
}

function readOnlyValue(value: string) {
  return (
    <Typo.Body as="span" style={readOnlyValueStyle}>
      {value}
    </Typo.Body>
  );
}
