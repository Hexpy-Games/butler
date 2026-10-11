import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/app/api.ts";
import { onboardingCompletedPatch } from "@/app/onboarding.ts";
import { useButlerStore } from "@/app/store.ts";
import type { PersonalizationView, SettingsView } from "@/app/types.ts";
import type { FirstRunProviderCardId } from "@/app/setupProviders.ts";
import type { FirstRunResult } from "./useFirstRunFlow";

type Connected = { cardId: FirstRunProviderCardId; settings: SettingsView };

/** Keep onboarding incomplete until the explicit reply choice is durable. */
export function useReplyLanguage({ connected, language, onComplete }: {
  connected: Connected | null;
  language: SettingsView["language"];
  onComplete: (result: FirstRunResult) => void;
}) {
  const [value, setValue] = useState<"ko" | "en" | null>(null);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const inFlight = useRef(false);
  const done = useRef(onComplete);
  done.current = onComplete;
  const finish = useCallback(async (choice?: "ko" | "en") => {
    if (!connected || inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    setFailed(false);
    try {
      if (choice) await api("/personalization", { method: "PATCH", body: JSON.stringify({ response_language: choice }) });
      const current = await api<SettingsView>("/settings");
      const now = new Date().toISOString();
      const patch = { language, ...onboardingCompletedPatch(current.onboarding, current.onboarding?.accepted_at ?? now, now) };
      const saved = await api<Partial<SettingsView>>("/settings", { method: "PATCH", body: JSON.stringify(patch) });
      useButlerStore.getState().setSettings({ ...current, ...patch, ...saved });
      done.current({ cardId: connected.cardId });
    } catch {
      setFailed(true);
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }, [connected, language]);

  useEffect(() => {
    if (!connected) return;
    let cancelled = false;
    setFailed(false);
    setValue(null);
    void api<PersonalizationView>("/personalization").then((view) => {
      if (cancelled) return;
      if (view.response_language !== "ko" && view.response_language !== "en") throw new Error("reply_language_missing");
      setValue(view.response_language);
    }).catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [attempt, connected]);

  return { value, setValue, saving, failed, retry: () => setAttempt((n) => n + 1), complete: () => value && void finish(value) };
}
