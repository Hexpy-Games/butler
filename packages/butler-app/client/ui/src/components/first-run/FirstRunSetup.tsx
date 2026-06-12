import type { FirstRunState } from "@/app/firstRunSetup.ts";
import { FirstRunProgress } from "./FirstRunProgress";
import { FirstRunStepContent } from "./FirstRunStepContent";
import { useFirstRunSetupController } from "./useFirstRunSetupController";
import styles from "./FirstRunSetup.module.css";

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
    <main className={styles.screen} data-test-class="first-run-setup">
      <section className={styles.panel}>
        <div className={styles.header}>
          <div className={styles.product}>{setup.copy.product}</div>
          <FirstRunProgress
            activeIndex={setup.stepIndex}
            labels={setup.copy.steps}
          />
        </div>
        <FirstRunStepContent
          copy={setup.copy}
          error={setup.error}
          advancedOpen={setup.advancedOpen}
          language={setup.language}
          status={setup.status}
          step={setup.step}
          onAcceptSafety={setup.onAcceptSafety}
          onBackToLanguage={setup.onBackToLanguage}
          onComplete={setup.onComplete}
          onLanguageChange={setup.onLanguageChange}
          onLanguageContinue={setup.onLanguageContinue}
          onRetryInstall={setup.onRetryInstall}
          onToggleAdvanced={setup.onToggleAdvanced}
          onUseExistingAgent={setup.onUseExistingAgent}
        />
      </section>
    </main>
  );
}
