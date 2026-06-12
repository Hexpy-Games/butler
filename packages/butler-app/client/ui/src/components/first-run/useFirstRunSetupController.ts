import { useEffect, useMemo, useState } from "react";
import { api } from "@/app/api.ts";
import { setAppCopyLanguage } from "@/app/copy.ts";
import {
  firstRunCompleteState,
  firstRunCopy,
  nextFirstRunState,
  settingsLanguagePatch,
  startFirstRunSetup,
  exportFirstRunSetupDiagnostics,
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
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [diagnosticsStatus, setDiagnosticsStatus] = useState("");
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
    let cancelled = false;
    async function prepareAgent() {
      setError("");
      setStatus(copy.installChecking);
      try {
        const setupStatus = await startFirstRunSetup();
        if (setupStatus.phase === "cancelled") return;
        if (setupStatus.phase !== "ready") throw new Error("setup_failed");
        if (!cancelled) {
          setStatus(copy.installReady);
          window.setTimeout(() => {
            if (!cancelled) markInstallReady();
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
    const completed = firstRunCompleteState(language);
    writeFirstRunState(window.localStorage, completed);
    onComplete(mode, completed);
  }

  function markInstallReady() {
    setState((current) =>
      nextFirstRunState(current, {
        type: "install_ready",
      }),
    );
  }

  function markInstallFailed(message: string) {
    setStatus("");
    setDiagnosticsStatus("");
    setError(message);
    setState((current) =>
      nextFirstRunState(current, {
        type: "install_failed",
        error: "setup_failed",
      }),
    );
  }

  async function copyDiagnostics() {
    try {
      const diagnostics = await exportFirstRunSetupDiagnostics();
      await navigator.clipboard.writeText(JSON.stringify(diagnostics, null, 2));
      setDiagnosticsStatus(copy.diagnosticsCopied);
    } catch {
      setDiagnosticsStatus(copy.diagnosticsUnavailable);
    }
  }

  function quitApp() {
    const bridge = window.butlerApp;
    if (typeof bridge?.quitApp === "function") {
      void bridge.quitApp();
      return;
    }
    window.close();
  }

  return {
    copy,
    diagnosticsStatus,
    error:
      error ||
      (step === "install" && state.install_status === "failed"
        ? copy.installFailed
        : ""),
    language,
    status,
    step,
    stepIndex,
    onAcceptSafety: () =>
      {
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
    onCopyDiagnostics: () => void copyDiagnostics(),
    onLanguageChange: (nextLanguage: FirstRunLanguage) =>
      setState((current) =>
        nextFirstRunState(current, {
          type: "select_language",
          language: nextLanguage,
        }),
      ),
    onLanguageContinue: () => void selectLanguage(),
    onRetryInstall: () => {
      setError("");
      setDiagnosticsStatus("");
      setStatus(copy.installChecking);
      setState((current) =>
        nextFirstRunState(current, { type: "retry_install" }),
      );
    },
    onQuit: quitApp,
  };
}
