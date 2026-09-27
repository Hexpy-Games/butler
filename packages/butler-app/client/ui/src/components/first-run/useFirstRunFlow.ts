import { useEffect, useState } from "react";
import { api } from "@/app/api.ts";
import { setAppCopyLanguage } from "@/app/copy.ts";
import { detectFirstRunLanguage, firstRunCopy, type FirstRunLanguage } from "@/app/firstRunSetup.ts";
import { notifyError } from "@/app/notifications.ts";
import { consentAcceptedPatch } from "@/app/onboarding.ts";
import { PROVIDER_CARDS, connectionCardId, type FirstRunProviderCardId, type LocalModelOption } from "@/app/setupProviders.ts";
import { useButlerStore } from "@/app/store.ts";
import type { ModelCatalogView, SettingsView } from "@/app/types.ts";
import { useConnectionCommit } from "./useConnectionCommit";
import { useLocalModelServers } from "./useLocalModelServers";
import { useOnlineStatus } from "./useOnlineStatus";
import { useSetupReadiness } from "./useSetupReadiness";
import { useSignIn } from "./useSignIn";

/** `first-run`: welcome, then pick an AI. `consent`: a newer consent only. `rerun`: from Settings, cancellable. */
export type FirstRunMode = "first-run" | "consent" | "rerun";

export type ConnectView =
  | { kind: "list" }
  | { kind: "signin" }
  | { kind: "key"; cardId: FirstRunProviderCardId }
  | { kind: "local" }
  | { kind: "custom" }
  | { kind: "customModels"; options: LocalModelOption[]; apiKey?: string };

/** What the first run connected, for the landing toast; null after a consent-only run. */
export type FirstRunResult = { cardId: FirstRunProviderCardId } | null;

/** The card of the model Butler uses now; only "Run setup again" shows it. */
function currentCardId(mode: FirstRunMode, modelRef: string, catalog: ModelCatalogView): FirstRunProviderCardId | null {
  if (mode !== "rerun" || !modelRef) return null;
  const model = [...(catalog.registered_models ?? []), ...catalog.models].find((entry) => entry.model_ref === modelRef);
  return connectionCardId(model);
}

function initialLanguage(mode: FirstRunMode): FirstRunLanguage {
  if (mode !== "first-run") return useButlerStore.getState().settings.language;
  return detectFirstRunLanguage(typeof navigator === "undefined" ? [] : navigator.languages);
}

export function useFirstRunFlow({ mode, onComplete, onCancel }: {
  mode: FirstRunMode;
  onComplete: (result: FirstRunResult) => void;
  /** Rerun only: leave without changing anything. */
  onCancel?: () => void;
}) {
  const [language, setLanguage] = useState<FirstRunLanguage>(() => initialLanguage(mode));
  const [screen, setScreen] = useState<"welcome" | "connect">("welcome");
  const [view, setView] = useState<ConnectView>({ kind: "list" });
  const [acceptedAt, setAcceptedAt] = useState<string | null>(null);
  const [savingConsent, setSavingConsent] = useState(false);
  const copy = firstRunCopy[language];
  const setup = useSetupReadiness();
  const online = useOnlineStatus();
  const current = useButlerStore((state) => currentCardId(mode, state.settings.model, state.modelCatalog));
  const local = useLocalModelServers({ enabled: screen === "connect", agentReady: setup.readiness.status === "ready" });
  const commit = useConnectionCommit({
    readinessStatus: setup.readiness.status,
    acceptedAt,
    language,
    onDone: (connection) => onComplete({ cardId: connection.cardId }),
  });
  const signIn = useSignIn({
    onSignedIn: () => commit.submit({ kind: "hosted", cardId: "chatgpt", providerId: "openai", authType: "codex_oauth" }),
  });

  useEffect(() => {
    setAppCopyLanguage(language);
  }, [language]);

  async function saveConsent(now: string): Promise<void> {
    setSavingConsent(true);
    try {
      const current = await api<SettingsView>("/settings");
      const patch = { language, ...consentAcceptedPatch(current.onboarding, now) };
      const saved = await api<Partial<SettingsView>>("/settings", { method: "PATCH", body: JSON.stringify(patch) });
      useButlerStore.getState().setSettings({ ...current, ...patch, ...saved, language });
      onComplete(null);
    } catch (error) {
      notifyError(error, copy.finishFailed, { id: "first-run-consent" });
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
    setScreen("connect");
  }

  function pick(cardId: FirstRunProviderCardId): void {
    const kind = PROVIDER_CARDS[cardId].kind;
    commit.clear();
    if (kind === "signin") {
      setView({ kind: "signin" });
      void signIn.start();
    } else if (kind === "key") setView({ kind: "key", cardId });
    else setView({ kind: kind === "local" ? "local" : "custom" });
  }

  return {
    mode, copy, language, setLanguage, online, screen, view, savingConsent, local, signIn, commit,
    currentCardId: current,
    readiness: setup.readiness,
    retryPreparation: setup.retry,
    repairPreparation: setup.repair,
    agree,
    pick,
    cancel: () => {
      signIn.leave();
      onCancel?.();
    },
    backToList: () => {
      signIn.leave();
      commit.clear();
      setView({ kind: "list" });
    },
    backToWelcome: () => setScreen("welcome"),
    showCustomModels: (options: LocalModelOption[], apiKey?: string) => setView({ kind: "customModels", options, apiKey }),
    connectKey: (cardId: FirstRunProviderCardId, credentialId: string) =>
      commit.submit({ kind: "hosted", cardId, providerId: PROVIDER_CARDS[cardId].providerId ?? cardId, authType: "api_key", credentialId }),
    connectLocal: (cardId: FirstRunProviderCardId, option: LocalModelOption, apiKey?: string) =>
      commit.submit({ kind: "local", cardId, option, apiKey }),
  };
}

export type FirstRunFlow = ReturnType<typeof useFirstRunFlow>;
