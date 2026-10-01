import { useState } from "react";
import { api } from "@/app/api.ts";
import { firstRunCopy, type FirstRunLanguage } from "@/app/firstRunSetup.ts";
import { notifyError } from "@/app/notifications.ts";
import { consentAcceptedPatch } from "@/app/onboarding.ts";
import { useButlerStore } from "@/app/store.ts";
import type { SettingsView } from "@/app/types.ts";
import type { FirstRunMode, FirstRunResult } from "./useFirstRunFlow";

/** Welcome owns consent; a consent-only renewal keeps the existing connection. */
export function useWelcomeConsent({ mode, language, onComplete, onAgree }: {
  mode: FirstRunMode;
  language: FirstRunLanguage;
  onComplete: (result: FirstRunResult) => void;
  onAgree: () => void;
}) {
  const [acceptedAt, setAcceptedAt] = useState<string | null>(null);
  const [savingConsent, setSavingConsent] = useState(false);
  async function saveConsent(now: string): Promise<void> {
    setSavingConsent(true);
    try {
      const current = await api<SettingsView>("/settings");
      const patch = { language, ...consentAcceptedPatch(current.onboarding, now) };
      const saved = await api<Partial<SettingsView>>("/settings", { method: "PATCH", body: JSON.stringify(patch) });
      useButlerStore.getState().setSettings({ ...current, ...patch, ...saved, language });
      onComplete(null);
    } catch (error) {
      notifyError(error, firstRunCopy[language].finishFailed, { id: "first-run-consent" });
    } finally {
      setSavingConsent(false);
    }
  }
  function agree(): void {
    const now = new Date().toISOString();
    if (mode === "consent") {
      void saveConsent(now);
      return;
    }
    setAcceptedAt(now);
    onAgree();
  }
  return { acceptedAt, savingConsent, agree };
}
