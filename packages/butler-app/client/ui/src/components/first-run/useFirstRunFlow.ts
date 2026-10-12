import { useEffect, useState } from "react";
import { setAppCopyLanguage } from "@/app/copy.ts";
import { detectFirstRunLanguage, firstRunCopy, type FirstRunLanguage } from "@/app/firstRunSetup.ts";
import { connectionCardId, type FirstRunProviderCardId, type LocalModelOption } from "@/app/setupProviders.ts";
import { useButlerStore } from "@/app/store.ts";
import type { ModelCatalogView } from "@/app/types.ts";
import { useWelcomeConsent } from "./useWelcomeConsent";
import { useReplyLanguage } from "./useReplyLanguage";
import { useConnectionCommit } from "./useConnectionCommit";
import { useLocalModelServers } from "./useLocalModelServers";
import { useMemoryChoice } from "./useMemoryChoice";
import { useOnlineStatus } from "./useOnlineStatus";
import { useSetupReadiness } from "./useSetupReadiness";
import { useSignIn } from "./useSignIn";
import { useFirstRunImports } from "./useFirstRunImports";
import { useFirstRunStages, connectionActions } from "./useFirstRunStages";
import type { FirstRunStep } from "./FirstRunSteps";

export type AiStage = "pick" | "auth" | "reply";
export type ImportStage = "agents" | "browsers";

/** `first-run`: welcome, consent, memory, pick an AI, optional import, then finish. `consent`: a newer consent only. `rerun`: from Settings, cancellable. */
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
  const [screen, setScreen] = useState<"welcome" | "consent" | "memory" | "connect">(mode === "consent" ? "consent" : "welcome");
  const [focusStart, setFocusStart] = useState(false);
  return {
    screen, setScreen, focusStart,
    start: () => setScreen("consent"),
    backToWelcome: () => { setFocusStart(true); setScreen("welcome"); },
    backToConsent: () => setScreen("consent"),
    /** First run returns to the memory step; renewal and rerun to consent. */
    backFromConnect: () => setScreen(mode === "first-run" ? "memory" : "consent"),
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
  const stages = useFirstRunStages(mode);
  const { view, importDone, authDone, replyDone, advanceOnConnect, importStage, setAuthDone, setReplyDone, setAdvanceOnConnect } = stages;
  const copy = firstRunCopy[language];
  const { acceptedAt, savingConsent, agree, clearAcceptance } = useWelcomeConsent({
    language, onAgree: () => setScreen(mode === "first-run" ? "memory" : "connect"),
  });
  const setup = useSetupReadiness();
  const memory = useMemoryChoice({ setup, saveFailed: copy.memoryChoice.saveFailed, onSaved: () => setScreen("connect") });
  const online = useOnlineStatus();
  const current = useButlerStore((state) => currentCardId(mode, state.settings.model, state.modelCatalog));
  const commit = useConnectionCommit({
    readinessStatus: setup.readiness.status,
    acceptedAt,
    language,
    resume: mode === "first-run",
  });
  const reply = useReplyLanguage({ connected: commit.connected, language, onComplete, onSaved: () => setReplyDone(true) });
  // A live or saved connection is always on the AI step, also for the render before the effect below moves `screen`.
  const settled = Boolean(commit.connected) || commit.waitingForReady;
  const step: FirstRunStep = !replyDone ? settled ? "connect" : screen : mode === "first-run" && !importDone ? "import" : "ready";
  // A saved connection (resume), a confirmed ② or a model pick that just connected opens ③ (no connected ② frame first).
  const advanced = authDone || (advanceOnConnect && Boolean(commit.connected));
  const aiStage: AiStage = advanced || ((commit.connected || commit.savedCardId) && view.kind === "list") ? "reply" : view.kind === "list" ? "pick" : "auth";
  useEffect(() => {
    if (advanceOnConnect && commit.connected) { setAdvanceOnConnect(false); setAuthDone(true); }
  }, [advanceOnConnect, commit.connected]);
  const imports = useFirstRunImports(mode === "first-run" && replyDone && setup.readiness.status === "ready");
  const local = useLocalModelServers({ enabled: step === "connect", agentReady: setup.readiness.status === "ready" });
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

  const stageKey = step === "connect" ? `connect:${aiStage}` : step === "import" ? `import:${importStage}` : step;
  const substep = step === "connect" ? { index: ["pick", "auth", "reply"].indexOf(aiStage) + 1, total: 3 }
    : step === "import" ? { index: importStage === "agents" ? 1 : 2, total: 2 } : undefined;

  return {
    mode, copy, language, setLanguage, online, screen, step, focusStart, view, savingConsent, local, signIn, commit, reply, memory,
    currentCardId: commit.connected?.cardId ?? current,
    readiness: setup.readiness,
    retryPreparation: setup.retry,
    repairPreparation: setup.repair,
    agree,
    start: navigation.start,
    ...connectionActions({ stages, commit, signIn, local, current, onCancel }),
    aiStage, importStage, stageKey, substep, ...imports,
    backToWelcome: navigation.backToWelcome,
    decline: () => navigation.decline(clearAcceptance),
    backToConsent: navigation.backToConsent,
    backFromConnect: navigation.backFromConnect,
  };
}

export type FirstRunFlow = ReturnType<typeof useFirstRunFlow>;
