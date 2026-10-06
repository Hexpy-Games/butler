import { faviconSrc } from "@/app/favicons.ts";
import { useAppLocale } from "@/app/copy.ts";
import { useEffect, useId, useState } from "react";
import { api, setDeveloperMode } from "@/app/api.ts";
import { appCopy } from "@/app/copy.ts";
import { notifyError, notifyStatus } from "@/app/notifications.ts";
import { useButlerStore } from "@/app/store.ts";
import type { AppInfoView, SettingsView } from "@/app/types.ts";
import { InlineReference, KeyValueRow, SettingsField, Switch, Typo } from "@/butler-ds";
import { SettingsPage, SettingsSection } from "./SettingsFormComponents";
import { OpenSourceLicenses } from "./OpenSourceLicenses";

export function AboutSettings() {
  const locale = useAppLocale();
  const [info, setInfo] = useState<AppInfoView | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [saving, setSaving] = useState(false);
  const setSettings = useButlerStore((state) => state.setSettings);
  const settingsCopy = appCopy.settings;
  const developerModeDescriptionId = useId();

  useEffect(() => {
    let cancelled = false;
    async function loadAppInfo() {
      try {
        setLoadFailed(false);
        const result = await api<AppInfoView>("/app-info");
        if (!cancelled) setInfo(result);
      } catch {
        if (!cancelled) setLoadFailed(true);
      }
    }
    loadAppInfo();
    return () => {
      cancelled = true;
    };
  }, [attempt]);

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

  const sections = settingsCopy.pageSections;
  const fields = settingsCopy.fields;
  return (
    <SettingsPage>
      <SettingsSection
        id="app-info"
        kind="info"
        title={sections.appInfo}
        state={info ? "ready" : loadFailed ? "error" : "loading"}
        errorMessage={settingsCopy.errors.loadAppInfo}
        onRetry={() => setAttempt((value) => value + 1)}
      >
        <KeyValueRow data-setting-id="app-name" data-test-class="about-app-name" label={fields.appName}
          value={info?.name ?? appCopy.firstRun.product} />
        <KeyValueRow data-setting-id="app-version" data-test-class="about-app-version" label={fields.appVersion}
          value={info?.version ?? "-"} />
        <KeyValueRow
          data-setting-id="app-repository"
          data-test-class="about-app-repository"
          label={fields.appRepository}
          value={info?.repository_url ? (
            <Typo.Body as="span" tone="primary">
              <InlineReference kind="external" href={info.repository_url} iconSrc={faviconSrc(info.repository_url)}>{repositoryLabel(info.repository_url)}</InlineReference>
            </Typo.Body>
          ) : "-"}
        />
        <KeyValueRow data-setting-id="app-protocol" data-test-class="about-app-protocol" label={fields.appProtocol}
          value={info?.protocol_version ?? "-"} />
      </SettingsSection>
      <SettingsSection id="open-source" kind="info" title={locale === "ko-KR" ? "라이선스" : "Licenses"}>
        <OpenSourceLicenses />
      </SettingsSection>
      <SettingsSection id="developer" kind="form" title={sections.developer}>
        <SettingsField
          id="about-developer-mode"
          settingId="developer-mode"
          label={fields.developerMode}
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
    </SettingsPage>
  );
}

function repositoryLabel(href: string): string {
  const url = new URL(href);
  return url.pathname.replace(/^\/+|\/+$/gu, "") || url.hostname;
}
