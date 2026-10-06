import { useEffect, useState } from "react";
import { appCopy, setAppCopyLanguage } from "@/app/copy";
import { appShellTheme } from "@/app/utils";
import { EMPTY_SETTINGS } from "@/app/constants";
import { useButlerStore } from "@/app/store";
import type { AppUpdateState } from "@/app/api";
import type { UpdateProgressView, UpdateStatusView } from "@/app/types";
import { AdaptiveShell, AdaptiveShellSidebar, AdaptiveShellWorkspace, ScrollArea, Button, ButtonContainer, PageContainer, SettingsHeader, Stack, Typo } from "@/butler-ds";
import { UpdatesSettings } from "@/components/settings/UpdatesSettings";
import { emptyComponentStatus } from "@/components/settings/emptyComponentStatus";
import { AppToaster } from "@/components/common/AppToaster";
import { receiveUpdateProgress } from "@/stores/updateProgressStore";
import { useUpdateProgressStore } from "@/stores/updateProgressStore";
import { usePortalThemeClasses } from "@/hooks/usePortalThemeClasses";

const stages: UpdateProgressView["stage"][] = ["idle", "checking", "downloading", "verifying", "ready", "applying", "restarting", "failed", "completed"];
let revision = 0;
const restartListeners = new Set<(state: AppUpdateState) => void>();
const failures = ["update_http_unavailable", "update_artifact_sha256_mismatch", "update_signature_unsupported", "update_manifest_app_platform_missing", "update_stage_unavailable", "update_activation_failed", "unexpected", "update_cancelled"];

function fixture(stage: UpdateProgressView["stage"], unknown: boolean, error: string, noBytes = false): UpdateStatusView {
  return {
    generated_at: "2026-10-03T00:00:00Z", storage_label: "updates", manifest_source: "stub", raw_text_included: false,
    components: [{ ...emptyComponentStatus("app"), current_version: stage === "completed" ? "0.1.1" : "0.1.0", available_version: "0.1.1", update_available: stage !== "completed", check_state: "ok", bundled_agent_version: "0.1.1" }],
    progress: { component: "app", stage, revision: ++revision, bytes_done: stage === "downloading" && !noBytes ? 44_102_000 : null,
      bytes_total: stage === "downloading" && !unknown ? 104857600 : null, cancellable: stage === "downloading", error_code: stage === "failed" ? error : null },
  };
}

/** Owner review surface uses the production settings screen and agent-shaped stub snapshots. */
export function UpdateProgressHarness() {
  const params = new URLSearchParams(window.location.search);
  const initialStage = params.get("stage") as UpdateProgressView["stage"];
  const [stage, setStage] = useState(stages.includes(initialStage) ? initialStage : "downloading");
  const [unknown, setUnknown] = useState(params.get("bytes") === "unknown");
  const [theme, setTheme] = useState<"light" | "dark">(params.get("theme") === "dark" ? "dark" : "light");
  const [locale, setLocale] = useState<"ko" | "en">(params.get("locale") === "en" ? "en" : "ko");
  const [noBytes, setNoBytes] = useState(false);
  const [error, setError] = useState(failures[1]!);
  const [restart, setRestart] = useState<AppUpdateState["status"]>("idle");
  const [visible, setVisible] = useState(true);
  const [installed, setInstalled] = useState(false);
  usePortalThemeClasses({ ...EMPTY_SETTINGS, appearance_theme: theme });
  useEffect(() => {
    setAppCopyLanguage(locale);
    useButlerStore.setState({ settings: { ...EMPTY_SETTINGS, appearance_theme: theme, language: locale } });
    const snapshot = fixture(stage, unknown, error, noBytes);
    const previous = window.butlerApp;
    window.butlerApp = {
      getAppUpdateState: async () => ({ status: restart, request_id: null }),
      onAppUpdateState: (listener) => { restartListeners.add(listener); return () => { restartListeners.delete(listener); }; },
      getUpdates: async () => snapshot,
      checkUpdates: async () => snapshot,
      applyUpdate: async () => { setStage(stage === "ready" ? "restarting" : "checking"); return snapshot.components[0]; },
      cancelUpdate: async () => { setStage("idle"); return { cancelled: true }; },
    };
    useUpdateProgressStore.getState().receive(snapshot.progress);
    restartListeners.forEach((listener) => listener({ status: restart, request_id: null }));
    setInstalled(true);
    return () => { window.butlerApp = previous; };
  }, [stage, unknown, theme, locale, error, restart, noBytes]);
  return (
    <AdaptiveShell leftOpen={false} rightOpen={false} theme={appShellTheme({ ...EMPTY_SETTINGS, appearance_theme: theme })}>
      <AdaptiveShellSidebar open={false} />
      <AdaptiveShellWorkspace><ScrollArea fill>
        <PageContainer width="full"><Stack gap="lg">
          <SettingsHeader title={appCopy.settings.sections.updates} description={appCopy.settings.sectionDescriptions.updates} />
          {installed && visible && <UpdatesSettings />}
          <ButtonContainer size="sm">
            {stages.map((value) => <Button key={value} size="sm" variant={stage === value ? "default" : "outline"}
              data-test-id={`stage-${value}`} onClick={() => setStage(value)}>{appCopy.settings.updateProgress[value]}</Button>)}
          </ButtonContainer>
          <ButtonContainer size="sm">
            <Button size="sm" variant="outline" data-test-id="harness-theme" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>{theme}</Button>
            <Button size="sm" variant="outline" data-test-id="harness-locale" onClick={() => setLocale(locale === "ko" ? "en" : "ko")}>{locale}</Button>
            <Button size="sm" variant="outline" data-test-id="harness-bytes" onClick={() => setUnknown(!unknown)}>{unknown ? "Bytes unavailable" : "Bytes available"}</Button>
            <Button size="sm" variant="outline" data-test-id="harness-navigation" onClick={() => setVisible(!visible)}>{visible ? "Leave settings" : "Return to settings"}</Button>
          </ButtonContainer>
          <ButtonContainer size="sm">
            <Button size="sm" data-test-id="harness-no-bytes" onClick={() => setNoBytes(!noBytes)}>Received bytes</Button>
            <Button size="sm" data-test-id="harness-deferred" onClick={() => { setStage("ready"); setRestart(restart === "deferred" ? "idle" : "deferred"); }}>After work</Button>
            <Button size="sm" data-test-id="harness-stale" onClick={() => receiveUpdateProgress({ type: "updates.progress", payload: { progress: { ...fixture("failed", false, failures[1]!).progress!, revision: 0 } } } as never)}>Late replay</Button>
            {failures.map((code, index) => <Button key={code} size="sm" data-test-id={`harness-error-${index}`} onClick={() => { setError(code); setStage("failed"); }}>{index + 1}</Button>)}
          </ButtonContainer>
          <AppToaster />
          <Typo.Caption>Settings harness · stub feed · 375 / 1280</Typo.Caption>
        </Stack></PageContainer>
      </ScrollArea></AdaptiveShellWorkspace>
    </AdaptiveShell>
  );
}
