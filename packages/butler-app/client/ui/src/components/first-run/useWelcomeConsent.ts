import { useRef, useState } from "react";
import { api } from "@/app/api.ts";
import { firstRunCopy, type FirstRunLanguage } from "@/app/firstRunSetup.ts";
import { notifyError } from "@/app/notifications.ts";
import { consentAcceptedPatch } from "@/app/onboarding.ts";
import { useButlerStore } from "@/app/store.ts";
import type { SettingsView } from "@/app/types.ts";

/** Persist agreement before opening connection actions. */
export function useWelcomeConsent({ language, onAgree }: {
  language: FirstRunLanguage;
  onAgree: () => void;
}) {
  const inFlight = useRef(false);
  const [acceptedAt, setAcceptedAt] = useState<string | null>(null);
  const [savingConsent, setSavingConsent] = useState(false);
  async function saveConsent(now: string): Promise<void> {
    if (inFlight.current) return;
    inFlight.current = true;
    setSavingConsent(true);
    try {
      const current = await api<SettingsView>("/settings");
      const patch = { language, ...consentAcceptedPatch(current.onboarding, now) };
      const saved = await api<Partial<SettingsView>>("/settings", { method: "PATCH", body: JSON.stringify(patch) });
      useButlerStore.getState().setSettings({ ...current, ...patch, ...saved, language });
      setAcceptedAt(now);
      onAgree();
    } catch (error) {
      notifyError(error, firstRunCopy[language].finishFailed, { id: "first-run-consent" });
    } finally {
      inFlight.current = false;
      setSavingConsent(false);
    }
  }
  function agree(): void {
    const now = new Date().toISOString();
    void saveConsent(now);
  }
  return { acceptedAt, savingConsent, agree, clearAcceptance: () => setAcceptedAt(null) };
}
