import { SetupWizardShell } from "@/butler-ds";
import { useAppLocale } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";
import { resolveAppearanceTheme } from "@/app/utils.ts";
import { WindowControls } from "@/components/layout/WindowControls";
import { useSystemThemePreference } from "@/hooks/useSystemThemePreference.ts";
import { FirstRunConsent } from "./FirstRunConsent";
import { FirstRunConnect } from "./FirstRunConnect";
import { FirstRunWelcome } from "./FirstRunWelcome";
import { FirstRunReady } from "./FirstRunReady";
import { useFirstRunFlow, type FirstRunMode, type FirstRunResult } from "./useFirstRunFlow";

export type { FirstRunMode, FirstRunResult };

interface FirstRunSetupProps {
  mode: FirstRunMode;
  onComplete: (result: FirstRunResult) => void;
  /** Rerun from Settings: leave without changes. */
  onCancel?: () => void;
}

/**
 * First run: welcome, consent, then "Pick an AI". The agent prepares in
 * the background; a newer consent version opens the consent step.
 */
export function FirstRunSetup({ mode, onComplete, onCancel }: FirstRunSetupProps) {
  useAppLocale();
  const flow = useFirstRunFlow({ mode, onComplete, onCancel });
  const appearance = useButlerStore((state) => state.settings.appearance_theme);
  const tone = resolveAppearanceTheme(appearance, useSystemThemePreference());
  return (
    <SetupWizardShell
      data-first-run-screen={flow.step}
      data-test-class="first-run-setup"
      title={flow.copy.product}
      tone={tone}
      variant="focus"
      anchor="top"
      stepKey={flow.step === "welcome" ? "welcome" : "steps"}
      onScroll={(event) => { event.currentTarget.scrollLeft = 0; }}
      windowControls={<WindowControls />}
    >
      {flow.step === "welcome" ? <FirstRunWelcome flow={flow} />
        : flow.step === "consent" ? <FirstRunConsent flow={flow} />
          : flow.step === "ready" ? <FirstRunReady flow={flow} /> : <FirstRunConnect flow={flow} />}
    </SetupWizardShell>
  );
}
