import { useEffect, useMemo, useState } from "react";
import { api } from "@/app/api.ts";
import {
  firstRunCompleteState,
  firstRunCopy,
  nextFirstRunState,
  settingsLanguagePatch,
  writeFirstRunState,
  type FirstRunState,
} from "@/app/firstRunSetup.ts";
import { setAppCopyLanguage } from "@/app/copy.ts";
import { FirstRunProgress } from "./FirstRunProgress";
import { FirstRunStepContent } from "./FirstRunStepContent";
import styles from "./FirstRunSetup.module.css";

interface FirstRunSetupProps {
  initialState: FirstRunState;
  onComplete: (mode: "workspace" | "model-settings", state: FirstRunState) => void;
}

export function FirstRunSetup({
  initialState,
  onComplete,
}: FirstRunSetupProps) {
  const [state, setState] = useState<FirstRunState>(initialState);
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
    writeFirstRunState(window.localStorage, {
      ...state,
    });
  }, [state]);

  useEffect(() => {
    if (step !== "install" || state.install_status !== "checking") return;
    let cancelled = false;
    async function prepareAgent() {
      setError("");
      setStatus(copy.installChecking);
      try {
        await api("/health");
        await api("/settings");
        if (!cancelled) {
          setStatus(copy.installReady);
          window.setTimeout(() => {
            if (!cancelled) {
              setState((current) =>
                nextFirstRunState(current, { type: "install_ready" }),
              );
            }
          }, 450);
        }
      } catch (installError) {
        if (!cancelled) {
          const message = copy.installFailed;
          setStatus("");
          setError(message);
          setState((current) =>
            nextFirstRunState(current, {
              type: "install_failed",
              error:
                installError instanceof Error
                  ? installError.message
                  : String(installError),
            }),
          );
        }
      }
    }
    void prepareAgent();
    return () => {
      cancelled = true;
    };
  }, [copy.installChecking, copy.installReady, state.install_status, step]);

  const complete = (mode: "workspace" | "model-settings") => {
    const completed = firstRunCompleteState(language);
    writeFirstRunState(window.localStorage, completed);
    onComplete(mode, completed);
  };

  const selectLanguage = async () => {
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
  };

  return (
    <main className={styles.screen} data-test-class="first-run-setup">
      <section className={styles.panel}>
        <div className={styles.header}>
          <div className={styles.product}>{copy.product}</div>
          <FirstRunProgress activeIndex={stepIndex} labels={copy.steps} />
        </div>
        <FirstRunStepContent
          copy={copy}
          error={
            error ||
            (step === "install" && state.install_status === "failed"
              ? copy.installFailed
              : "")
          }
          language={language}
          status={status}
          step={step}
          onAcceptSafety={() =>
            setState((current) =>
              nextFirstRunState(
                nextFirstRunState(current, { type: "accept_safety" }),
                { type: "begin_install" },
              ),
            )
          }
          onBackToLanguage={() =>
            setState((current) =>
              nextFirstRunState(current, { type: "back_to_language" }),
            )
          }
          onComplete={complete}
          onLanguageChange={(nextLanguage) =>
            setState((current) =>
              nextFirstRunState(current, {
                type: "select_language",
                language: nextLanguage,
              }),
            )
          }
          onLanguageContinue={() => void selectLanguage()}
          onRetryInstall={() => {
            setError("");
            setStatus(copy.installChecking);
            setState((current) =>
              nextFirstRunState(current, { type: "retry_install" }),
            );
          }}
        />
      </section>
    </main>
  );
}
