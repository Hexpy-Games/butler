import { useState } from "react";
import { SetupWizardShell } from "@/butler-ds";
import { useAppLocale } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";
import { resolveAppearanceTheme } from "@/app/utils.ts";
import { WindowControls } from "@/components/layout/WindowControls";
import { useSystemThemePreference } from "@/hooks/useSystemThemePreference.ts";
import { FirstRunBrowserImport } from "./FirstRunBrowserImport";
import { useSetupScene } from "./useSetupSceneReady";
import { FirstRunConsent } from "./FirstRunConsent";
import { FirstRunConnect } from "./FirstRunConnect";
import { FirstRunMemory } from "./FirstRunMemory";
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
 * First run: welcome, consent, memory, then "Pick an AI". The agent prepares in
 * the background; a newer consent version opens the consent step.
 */
export function FirstRunSetup({ mode, onComplete, onCancel }: FirstRunSetupProps) {
  useAppLocale();
  const flow = useFirstRunFlow({ mode, onComplete, onCancel });
  const appearance = useButlerStore((state) => state.settings.appearance_theme);
  const tone = resolveAppearanceTheme(appearance, useSystemThemePreference());
  const completedAt = useButlerStore((state) => state.settings.onboarding?.completed_at);
  // The card renders at once; the intro waits for a visible window, or settles still when the window stays unseen.
  const scene = useSetupScene();
  // Ink intro, from the setup state at mount: the full intro only on a fresh first run that starts at welcome (still
  // print when the window stays unseen); Settings re-run keeps the still print; a resumed setup (consent saved, or a
  // later first step) starts on the drift with no ink (none), also when it goes back to welcome.
  const [fresh] = useState(() => mode === "first-run" && flow.step === "welcome" && !useButlerStore.getState().settings.onboarding?.accepted_at);
  const intro = fresh && !completedAt ? (scene !== "still" ? "full" : "rerun") : mode === "rerun" ? "rerun" : "none";
  return (
    <SetupWizardShell
      data-first-run-screen={flow.step}
      data-test-class="first-run-setup"
      title={flow.copy.product}
      tone={tone}
      variant="focus"
      anchor="top"
      intro={intro}
      introHeld={scene === "hold"}
      stepKey={flow.step}
      onScroll={(event) => { event.currentTarget.scrollLeft = 0; }}
      windowControls={<WindowControls />}
    >
      {flow.step === "welcome" ? <FirstRunWelcome flow={flow} />
        : flow.step === "consent" ? <FirstRunConsent flow={flow} />
          : flow.step === "memory" ? <FirstRunMemory flow={flow} />
          : flow.step === "import" ? <FirstRunBrowserImport flow={flow} />
          : flow.step === "ready" ? <FirstRunReady flow={flow} /> : <FirstRunConnect flow={flow} />}
    </SetupWizardShell>
  );
}
