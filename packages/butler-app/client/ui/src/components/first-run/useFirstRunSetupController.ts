import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/app/api.ts";
import { setAppCopyLanguage } from "@/app/copy.ts";
import {
  firstRunCompleteState,
  firstRunCopy,
  nextFirstRunState,
  settingsLanguagePatch,
  startFirstRunSetup,
  writeFirstRunState,
  type FirstRunLanguage,
  type FirstRunState,
} from "@/app/firstRunSetup.ts";

type CompleteMode = "workspace" | "model-settings";

export function useFirstRunSetupController(
  initialState: FirstRunState,
  onComplete: (mode: CompleteMode, state: FirstRunState) => void,
) {
  const [state, setState] = useState<FirstRunState>(initialState);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const bundledSetupSuppressedRef = useRef(false);
  const manualConnectionPendingRef = useRef(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const language = state.language;
  const step = state.step;
  const copy = firstRunCopy[language];
  const stepIndex = useMemo(
    () => ["language", "safety", "install", "model"].indexOf(step),
    [step],
  );

  useEffect(() => {
    setAppCopyLanguage(language);
    writeFirstRunState(window.localStorage, state);
  }, [language, state]);

  useEffect(() => {
    if (step !== "install" || state.install_status !== "checking") return;
    if (manualConnectionPendingRef.current) return;
    let cancelled = false;
    async function prepareAgent() {
      setError("");
      setStatus(copy.installChecking);
      try {
        const setupStatus = await startFirstRunSetup("bundled-agent");
        if (setupStatus.phase === "cancelled") return;
        if (setupStatus.phase !== "ready") throw new Error("setup_failed");
        if (!cancelled) {
          setStatus(copy.installReady);
          window.setTimeout(() => {
            if (
              !cancelled &&
              !manualConnectionPendingRef.current &&
              !bundledSetupSuppressedRef.current
            ) {
              markInstallReady("bundled-agent");
            }
          }, 450);
        }
      } catch {
        if (!cancelled) markInstallFailed(copy.installFailed);
      }
    }
    void prepareAgent();
    return () => {
      cancelled = true;
    };
  }, [
    copy.installChecking,
    copy.installReady,
    state.install_status,
    step,
  ]);

  async function connectExistingAgent() {
    bundledSetupSuppressedRef.current = true;
    manualConnectionPendingRef.current = true;
    setError("");
    setStatus(copy.checkingCompatibility);
    setState((current) =>
      nextFirstRunState(current, { type: "retry_install" }),
    );
    try {
      const setupStatus = await startFirstRunSetup("existing-agent");
      if (setupStatus.phase !== "ready") throw new Error("setup_failed");
      setStatus(copy.installReady);
      markInstallReady("existing-agent");
    } catch {
      markInstallFailed(copy.installFailed);
    } finally {
      manualConnectionPendingRef.current = false;
    }
  }

  async function selectLanguage() {
    setError("");
    try {
      await api("/settings", {
        method: "PATCH",
        body: JSON.stringify(settingsLanguagePatch(language)),
      });
    } catch {
      // The visible app language still follows the selected first-run language.
    }
    setState((current) =>
      nextFirstRunState(current, { type: "continue_language" }),
    );
  }

  function complete(mode: CompleteMode) {
    const completed = firstRunCompleteState(
      language,
      state.connection_mode ?? "bundled-agent",
    );
    writeFirstRunState(window.localStorage, completed);
    onComplete(mode, completed);
  }

  function markInstallReady(connectionMode: FirstRunState["connection_mode"]) {
    setState((current) =>
      nextFirstRunState(current, {
        type: "install_ready",
        connection_mode: connectionMode,
      }),
    );
  }

  function markInstallFailed(message: string) {
    setStatus("");
    setError(message);
    setState((current) =>
      nextFirstRunState(current, {
        type: "install_failed",
        error: "setup_failed",
      }),
    );
  }

  return {
    copy,
    error:
      error ||
      (step === "install" && state.install_status === "failed"
        ? copy.installFailed
        : ""),
    language,
    advancedOpen,
    status,
    step,
    stepIndex,
    onAcceptSafety: () =>
      {
        bundledSetupSuppressedRef.current = false;
        setState((current) =>
          nextFirstRunState(
            nextFirstRunState(current, { type: "accept_safety" }),
            { type: "begin_install" },
          ),
        );
      },
    onBackToLanguage: () =>
      setState((current) =>
        nextFirstRunState(current, { type: "back_to_language" }),
      ),
    onComplete: complete,
    onLanguageChange: (nextLanguage: FirstRunLanguage) =>
      setState((current) =>
        nextFirstRunState(current, {
          type: "select_language",
          language: nextLanguage,
        }),
      ),
    onLanguageContinue: () => void selectLanguage(),
    onToggleAdvanced: () => setAdvancedOpen((current) => !current),
    onRetryInstall: () => {
      bundledSetupSuppressedRef.current = false;
      setError("");
      setStatus(copy.installChecking);
      setState((current) =>
        nextFirstRunState(current, { type: "retry_install" }),
      );
    },
    onUseExistingAgent: () => void connectExistingAgent(),
  };
}
