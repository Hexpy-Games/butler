import type { FirstRunState } from "@/app/firstRunSetup.ts";
import { SetupWizardShell } from "@/butler-ds";
import { FirstRunStepContent } from "./FirstRunStepContent";
import { useFirstRunSetupController } from "./useFirstRunSetupController";
import { WindowControls } from "@/components/layout/WindowControls";
import { useButlerStore } from "@/app/store.ts";
import { resolveAppearanceTheme } from "@/app/utils.ts";
import { useSystemThemePreference } from "@/hooks/useSystemThemePreference.ts";

interface FirstRunSetupProps {
  initialState: FirstRunState;
  onComplete: (mode: "workspace" | "model-settings", state: FirstRunState) => void;
}

export function FirstRunSetup({
  initialState,
  onComplete,
}: FirstRunSetupProps) {
  const setup = useFirstRunSetupController(initialState, onComplete);
  const appearance = useButlerStore((state) => state.settings.appearance_theme);
  const tone = resolveAppearanceTheme(appearance, useSystemThemePreference());

  return (
    <SetupWizardShell
      activeIndex={setup.stepIndex}
      data-test-class="first-run-setup"
      progressLabel="First-run setup steps"
      steps={setup.copy.steps.map((label) => ({ id: label, label }))}
      title={setup.copy.product}
      tone={tone}
      windowControls={<WindowControls />}
    >
      <FirstRunStepContent
        copy={setup.copy}
        diagnosticsStatus={setup.diagnosticsStatus}
        error={setup.error}
        language={setup.language}
        modelLoadFailed={setup.modelLoadFailed}
        modelSaveStatus={setup.modelSaveStatus}
        modelSettingsReady={setup.modelSettingsReady}
        status={setup.status}
        step={setup.step}
        onAcceptSafety={setup.onAcceptSafety}
        onBackToLanguage={setup.onBackToLanguage}
        onCopyDiagnostics={setup.onCopyDiagnostics}
        onLanguageChange={setup.onLanguageChange}
        onLanguageContinue={setup.onLanguageContinue}
        onQuit={setup.onQuit}
        onRepairInstall={setup.onRepairInstall}
        onRetryInstall={setup.onRetryInstall}
        onRetryModelLoad={setup.onRetryModelLoad}
        onRetryModelSave={setup.onRetryModelSave}
      />
    </SetupWizardShell>
  );
}
