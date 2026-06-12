import {
  firstRunCopy,
  type FirstRunLanguage,
  type FirstRunStep,
} from "@/app/firstRunSetup.ts";
import { Button, NativeSelect, NativeSelectOption } from "@/butler-ds";
import styles from "./FirstRunSetup.module.css";

type FirstRunCopy = (typeof firstRunCopy)[FirstRunLanguage];

interface FirstRunStepContentProps {
  copy: FirstRunCopy;
  error: string;
  language: FirstRunLanguage;
  status: string;
  step: FirstRunStep;
  onAcceptSafety: () => void;
  onBackToLanguage: () => void;
  onComplete: (mode: "workspace" | "model-settings") => void;
  onLanguageChange: (language: FirstRunLanguage) => void;
  onLanguageContinue: () => void;
  onRetryInstall: () => void;
}

export function FirstRunStepContent({
  copy,
  error,
  language,
  status,
  step,
  onAcceptSafety,
  onBackToLanguage,
  onComplete,
  onLanguageChange,
  onLanguageContinue,
  onRetryInstall,
}: FirstRunStepContentProps) {
  if (step === "language") {
    return (
      <div className={styles.content}>
        <h1>{copy.languageTitle}</h1>
        <NativeSelect
          value={language}
          onChange={(event) =>
            onLanguageChange(event.currentTarget.value as FirstRunLanguage)
          }
          aria-label={copy.languageTitle}
        >
          <NativeSelectOption value="ko">한국어</NativeSelectOption>
          <NativeSelectOption value="en">English</NativeSelectOption>
        </NativeSelect>
        <Button type="button" onClick={onLanguageContinue}>
          {copy.continue}
        </Button>
      </div>
    );
  }

  if (step === "safety") {
    return (
      <div className={styles.content}>
        <h1>{copy.safetyTitle}</h1>
        <p>{copy.safetyBody}</p>
        <div className={styles.actions}>
          <Button type="button" variant="outline" onClick={onBackToLanguage}>
            {copy.back}
          </Button>
          <Button type="button" onClick={onAcceptSafety}>
            {copy.accept}
          </Button>
        </div>
      </div>
    );
  }

  if (step === "install") {
    return (
      <div className={styles.content}>
        <h1>{copy.installTitle}</h1>
        <p>{error || status}</p>
        {error && (
          <Button type="button" onClick={onRetryInstall}>
            {copy.retry}
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className={styles.content}>
      <h1>{copy.modelTitle}</h1>
      <p>{copy.modelBody}</p>
      <div className={styles.actions}>
        <Button
          type="button"
          variant="outline"
          onClick={() => onComplete("workspace")}
        >
          {copy.finish}
        </Button>
        <Button type="button" onClick={() => onComplete("model-settings")}>
          {copy.openModelSettings}
        </Button>
      </div>
    </div>
  );
}
