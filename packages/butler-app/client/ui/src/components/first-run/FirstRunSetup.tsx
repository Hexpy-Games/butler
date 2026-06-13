import type { FirstRunState } from "@/app/firstRunSetup.ts";
import { SetupWizardShell } from "@/butler-ds";
import { FirstRunStepContent } from "./FirstRunStepContent";
import { useFirstRunSetupController } from "./useFirstRunSetupController";

interface FirstRunSetupProps {
  initialState: FirstRunState;
  onComplete: (mode: "workspace" | "model-settings", state: FirstRunState) => void;
}

export function FirstRunSetup({
  initialState,
  onComplete,
}: FirstRunSetupProps) {
  const setup = useFirstRunSetupController(initialState, onComplete);

  return (
    <SetupWizardShell
      activeIndex={setup.stepIndex}
      data-test-class="first-run-setup"
      progressLabel="First-run setup steps"
      steps={setup.copy.steps.map((label) => ({ id: label, label }))}
      title={setup.copy.product}
    >
      <FirstRunStepContent
        copy={setup.copy}
        diagnosticsStatus={setup.diagnosticsStatus}
        error={setup.error}
        language={setup.language}
        modelLoadFailed={setup.modelLoadFailed}
        modelOptions={setup.modelOptions}
        modelSaveStatus={setup.modelSaveStatus}
        modelSaving={setup.modelSaving}
        selectedDescription={setup.selectedDescription}
        selectedModel={setup.selectedModel}
        status={setup.status}
        step={setup.step}
        onAcceptSafety={setup.onAcceptSafety}
        onBackToLanguage={setup.onBackToLanguage}
        onCopyDiagnostics={setup.onCopyDiagnostics}
        onLanguageChange={setup.onLanguageChange}
        onLanguageContinue={setup.onLanguageContinue}
        onModelChange={setup.onModelChange}
        onQuit={setup.onQuit}
        onRetryInstall={setup.onRetryInstall}
        onRetryModelLoad={setup.onRetryModelLoad}
        onSaveModel={setup.onSaveModel}
      />
    </SetupWizardShell>
  );
}
