import { useEffect, useState } from "react";
import { setAppCopyLanguage } from "@/app/copy.ts";
import { detectFirstRunLanguage, firstRunCopy, type FirstRunLanguage } from "@/app/firstRunSetup.ts";
import { PROVIDER_CARDS, connectionCardId, type FirstRunProviderCardId, type LocalModelOption } from "@/app/setupProviders.ts";
import { useButlerStore } from "@/app/store.ts";
import type { ModelCatalogView } from "@/app/types.ts";
import { useWelcomeConsent } from "./useWelcomeConsent";
import { useReplyLanguage } from "./useReplyLanguage";
import { useConnectionCommit } from "./useConnectionCommit";
import { useLocalModelServers } from "./useLocalModelServers";
import { useOnlineStatus } from "./useOnlineStatus";
import { useSetupReadiness } from "./useSetupReadiness";
import { useSignIn } from "./useSignIn";

/** `first-run`: welcome, consent, then pick an AI. `consent`: a newer consent only. `rerun`: from Settings, cancellable. */
export type FirstRunMode = "first-run" | "consent" | "rerun";

export type ConnectView =
  | { kind: "list" }
  | { kind: "signin" }
  | { kind: "key"; cardId: FirstRunProviderCardId }
  | { kind: "local" }
  | { kind: "custom" }
  | { kind: "customModels"; options: LocalModelOption[]; apiKey?: string };

/** What the first run connected, for the landing toast; null when no connection changes. */
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

/** Navigation stays local; declining never changes durable onboarding. */
function useConsentScreen(mode: FirstRunMode) {
  const [screen, setScreen] = useState<"welcome" | "consent" | "connect">(mode === "consent" ? "consent" : "welcome");
  const [focusStart, setFocusStart] = useState(false);
  return {
    screen, setScreen, focusStart,
    start: () => setScreen("consent"),
    backToConsent: () => setScreen("consent"),
    decline: (clearAcceptance: () => void) => {
      clearAcceptance();
      setFocusStart(true);
      setScreen("welcome");
    },
  };
}

export function useFirstRunFlow({ mode, onComplete, onCancel }: {
  mode: FirstRunMode;
  onComplete: (result: FirstRunResult) => void;
  /** Rerun only: leave without changing anything. */
  onCancel?: () => void;
}) {
  const [language, setLanguage] = useState<FirstRunLanguage>(() => initialLanguage(mode));
  const navigation = useConsentScreen(mode);
  const { screen, setScreen, focusStart } = navigation;
  const [view, setView] = useState<ConnectView>({ kind: "list" });
  const copy = firstRunCopy[language];
  const { acceptedAt, savingConsent, agree, clearAcceptance } = useWelcomeConsent({ language, onAgree: () => setScreen("connect") });
  const setup = useSetupReadiness();
  const online = useOnlineStatus();
  const current = useButlerStore((state) => currentCardId(mode, state.settings.model, state.modelCatalog));
  const local = useLocalModelServers({ enabled: screen === "connect", agentReady: setup.readiness.status === "ready" });
  const commit = useConnectionCommit({
    readinessStatus: setup.readiness.status,
    acceptedAt,
    language,
    resume: mode === "first-run",
  });
  const reply = useReplyLanguage({ connected: commit.connected, language, onComplete });
  useEffect(() => {
    if (commit.connected) {
      setLanguage(commit.connected.settings.language);
      setScreen("connect");
    }
  }, [commit.connected]);
  const signIn = useSignIn({
    onSignedIn: () => commit.submit({
      kind: "hosted", cardId: "chatgpt", providerId: "openai", authType: "codex_oauth", keepDefaults: current === "chatgpt",
    }),
  });

  useEffect(() => {
    setAppCopyLanguage(language);
  }, [language]);

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
    mode, copy, language, setLanguage, online, screen, focusStart, view, savingConsent, local, signIn, commit, reply,
    currentCardId: commit.connected?.cardId ?? current,
    readiness: setup.readiness,
    retryPreparation: setup.retry,
    repairPreparation: setup.repair,
    agree,
    start: navigation.start,
    decline: () => navigation.decline(clearAcceptance),
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
    backToConsent: navigation.backToConsent,
    showCustomModels: (options: LocalModelOption[], apiKey?: string) => setView({ kind: "customModels", options, apiKey }),
    connectKey: (cardId: FirstRunProviderCardId, credentialId: string) =>
      commit.submit({
        kind: "hosted", cardId, providerId: PROVIDER_CARDS[cardId].providerId ?? cardId, authType: "api_key", credentialId,
        // Routine presets are for a new AI; the AI already in use keeps its model and effort.
        keepDefaults: current === cardId,
      }),
    connectLocal: (cardId: FirstRunProviderCardId, option: LocalModelOption, apiKey?: string) =>
      commit.submit({ kind: "local", cardId, option, apiKey }),
  };
}

export type FirstRunFlow = ReturnType<typeof useFirstRunFlow>;
