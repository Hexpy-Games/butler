import { SetupWizardShell } from "@/butler-ds";
import { useAppLocale } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";
import { resolveAppearanceTheme } from "@/app/utils.ts";
import { WindowControls } from "@/components/layout/WindowControls";
import { useSystemThemePreference } from "@/hooks/useSystemThemePreference.ts";
import { FirstRunConnect } from "./FirstRunConnect";
import { FirstRunWelcome } from "./FirstRunWelcome";
import { useFirstRunFlow, type FirstRunMode, type FirstRunResult } from "./useFirstRunFlow";

export type { FirstRunMode, FirstRunResult };

interface FirstRunSetupProps {
  mode: FirstRunMode;
  onComplete: (result: FirstRunResult) => void;
  /** Rerun from Settings: leave without changes. */
  onCancel?: () => void;
}

/**
 * First run: a welcome with consent, then "Pick an AI". The agent prepares in
 * the background; a newer consent version shows the welcome alone.
 */
export function FirstRunSetup({ mode, onComplete, onCancel }: FirstRunSetupProps) {
  useAppLocale();
  const flow = useFirstRunFlow({ mode, onComplete, onCancel });
  const appearance = useButlerStore((state) => state.settings.appearance_theme);
  const tone = resolveAppearanceTheme(appearance, useSystemThemePreference());
  return (
    <SetupWizardShell
      data-first-run-screen={flow.screen}
      data-test-class="first-run-setup"
      title={flow.copy.product}
      tone={tone}
      variant="focus"
      windowControls={<WindowControls />}
    >
      {flow.screen === "welcome" ? <FirstRunWelcome flow={flow} /> : <FirstRunConnect flow={flow} />}
    </SetupWizardShell>
  );
}
