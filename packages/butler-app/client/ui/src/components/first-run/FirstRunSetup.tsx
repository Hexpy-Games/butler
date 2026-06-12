import type { FirstRunState } from "@/app/firstRunSetup.ts";
import { FirstRunProgress } from "./FirstRunProgress";
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
    <main className="first-run-setup-screen" data-test-class="first-run-setup">
      <section className="first-run-setup-panel">
        <div className="first-run-setup-header">
          <div className="first-run-setup-product">{setup.copy.product}</div>
          <FirstRunProgress
            activeIndex={setup.stepIndex}
            labels={setup.copy.steps}
          />
        </div>
        <FirstRunStepContent
          copy={setup.copy}
          diagnosticsStatus={setup.diagnosticsStatus}
          error={setup.error}
          language={setup.language}
          status={setup.status}
          step={setup.step}
          onAcceptSafety={setup.onAcceptSafety}
          onBackToLanguage={setup.onBackToLanguage}
          onComplete={setup.onComplete}
          onCopyDiagnostics={setup.onCopyDiagnostics}
          onLanguageChange={setup.onLanguageChange}
          onLanguageContinue={setup.onLanguageContinue}
          onQuit={setup.onQuit}
          onRetryInstall={setup.onRetryInstall}
        />
      </section>
    </main>
  );
}
