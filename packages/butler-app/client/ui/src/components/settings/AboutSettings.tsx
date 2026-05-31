import { useEffect, useState, type CSSProperties } from "react";
import { api, setDeveloperMode } from "@/app/api.ts";
import { appCopy } from "@/app/copy.ts";
import { notifyError, notifyStatus } from "@/app/notifications.ts";
import type { AppInfoView } from "@/app/types.ts";
import { SettingsField, Switch, Typo } from "@/butler-ds";
import { SettingsSection } from "./SettingsFormComponents";

const readOnlyValueStyle: CSSProperties = {
  color: "var(--text-primary)",
  overflowWrap: "anywhere",
};

export function AboutSettings() {
  const [info, setInfo] = useState<AppInfoView | null>(null);
  const [saving, setSaving] = useState(false);
  const settingsCopy = appCopy.settings;

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
    try {
      const next = await setDeveloperMode(enabled);
      setInfo(next);
      notifyStatus(settingsCopy.saved, {
        id: "developer-mode",
        tone: "ok",
      });
    } catch (error) {
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
        label={settingsCopy.fields.developerMode}
        description={settingsCopy.descriptions.developerMode}
        control={
          <Switch
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
