import { useEffect, useMemo, useState } from "react";
import { setAppCopyLanguage } from "@/app/copy.ts";
import {
  firstRunCompleteState,
  firstRunCopy,
  nextFirstRunState,
  startFirstRunSetup,
  exportFirstRunSetupDiagnostics,
  writeFirstRunState,
  type FirstRunLanguage,
  type FirstRunState,
} from "@/app/firstRunSetup.ts";
import { useFirstRunModelSetup } from "./useFirstRunModelSetup";

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
  const modelSetup = useFirstRunModelSetup({
    copy,
    enabled: step === "model",
    language,
    onComplete: () => complete("workspace"),
  });

  useEffect(() => {
    setAppCopyLanguage(language);
    writeFirstRunState(window.localStorage, state);
  }, [language, state]);

  useEffect(() => {
    if (
      step !== "install" ||
      !["checking", "idle"].includes(state.install_status ?? "idle")
    ) {
      return;
    }
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

  function selectLanguage() {
    setError("");
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
    modelLoadFailed: modelSetup.modelLoadFailed,
    modelSaveStatus: modelSetup.modelSaveStatus,
    modelSettingsReady: modelSetup.modelSettingsReady,
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
    onCopyDiagnostics: () => void copyDiagnostics(),
    onLanguageChange: (nextLanguage: FirstRunLanguage) =>
      setState((current) =>
        nextFirstRunState(current, {
          type: "select_language",
          language: nextLanguage,
        }),
      ),
    onRetryModelLoad: modelSetup.onRetryModelLoad,
    onRetryModelSave: modelSetup.onRetryModelSave,
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
