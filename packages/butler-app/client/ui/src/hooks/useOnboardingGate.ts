import { useEffect, useState } from "react";
import { api } from "@/app/api.ts";
import {
  LEGACY_FIRST_RUN_STORAGE_KEY,
  legacyFirstRunCompleteRecord,
  legacyMigrationPatch,
  readLegacyFirstRunCompletedAt,
  resolveOnboardingGate,
  type OnboardingGate,
} from "@/app/onboarding.ts";
import { useButlerStore } from "@/app/store.ts";
import type { ModelCatalogView, OnboardingSettingsView, SettingsView } from "@/app/types.ts";

/** Retry delay while the agent is still starting. */
export const ONBOARDING_SETTINGS_RETRY_MS = 2000;

/** `pending` until the agent answers; `legacy` for an agent without `settings.onboarding`. */
type AgentOnboarding = { loaded: false } | { loaded: true; onboarding: OnboardingSettingsView | null };

function writeLegacyCompletion(): void {
  safeStorage()?.setItem(LEGACY_FIRST_RUN_STORAGE_KEY, JSON.stringify(legacyFirstRunCompleteRecord()));
}

function safeStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Decides whether the first run shows, from the agent's `settings.onboarding`
 * (#230). An install that finished setup before #230 has only the renderer
 * flag: it is PATCHed into the agent once and then removed. Contract
 * assumption: a #230 agent always returns `onboarding` (fields may be null);
 * an agent without the field keeps the legacy flag in charge.
 */
export function useOnboardingGate(): { gate: OnboardingGate; markComplete: () => void } {
  const [legacyCompletedAt, setLegacyCompletedAt] = useState(() => {
    const storage = safeStorage();
    return storage ? readLegacyFirstRunCompletedAt(storage) : null;
  });
  const [agent, setAgent] = useState<AgentOnboarding>({ loaded: false });
  const [completed, setCompleted] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const [settings, catalog] = await Promise.all([
          api<SettingsView>("/settings"), api<ModelCatalogView>("/model-catalog"),
        ]);
        if (cancelled) return;
        useButlerStore.getState().setSettings(settings);
        useButlerStore.getState().setModelCatalog(catalog);
        if (!settings.onboarding) {
          setAgent({ loaded: true, onboarding: null });
          return;
        }
        let onboarding = settings.onboarding;
        const migration = legacyMigrationPatch(onboarding, legacyCompletedAt);
        if (migration) {
          // A rejected migration (malformed legacy time) is not fatal: the
          // legacy flag keeps counting this session and the next start tries again.
          const migrated = await api("/settings", { method: "PATCH", body: JSON.stringify(migration) }).then(() => true, () => false);
          if (migrated) {
            onboarding = migration.onboarding;
            safeStorage()?.removeItem(LEGACY_FIRST_RUN_STORAGE_KEY);
            if (!cancelled) setLegacyCompletedAt(null);
          }
        }
        if (!cancelled) setAgent({ loaded: true, onboarding });
      } catch {
        if (!cancelled) timer = setTimeout(() => void load(), ONBOARDING_SETTINGS_RETRY_MS);
      }
    };
    void load();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // Load once per app start; the legacy flag is read once above.
  }, []);

  const gate = completed ? "workspace" : resolveOnboardingGate({
    onboarding: agent.loaded ? agent.onboarding : null,
    agentLoaded: agent.loaded,
    legacyCompletedAt,
  });
  return {
    gate,
    markComplete: () => {
      // Only an agent that cannot store onboarding keeps the renderer flag.
      if (agent.loaded && !agent.onboarding) writeLegacyCompletion();
      setCompleted(true);
    },
  };
}
