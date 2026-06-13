import {
  firstRunCopy,
  type FirstRunLanguage,
  type FirstRunStep,
} from "@/app/firstRunSetup.ts";
import {
  Button,
  ButtonContainer,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SetupWizardContent,
  SetupWizardList,
  Stack,
  Typo,
} from "@/butler-ds";
import { FirstRunModelStep } from "./FirstRunModelStep";

type FirstRunCopy = (typeof firstRunCopy)[FirstRunLanguage];

interface FirstRunStepContentProps {
  copy: FirstRunCopy;
  diagnosticsStatus: string;
  error: string;
  language: FirstRunLanguage;
  modelLoadFailed: boolean;
  modelSaveStatus: string;
  modelSettingsReady: boolean;
  modelSetupReady: boolean;
  status: string;
  step: FirstRunStep;
  onAcceptSafety: () => void;
  onBackToLanguage: () => void;
  onCopyDiagnostics: () => void;
  onLanguageChange: (language: FirstRunLanguage) => void;
  onLanguageContinue: () => void;
  onQuit: () => void;
  onRetryModelLoad: () => void;
  onRetryInstall: () => void;
  onSaveModel: () => void;
}

export function FirstRunStepContent({
  copy,
  diagnosticsStatus,
  error,
  language,
  modelLoadFailed,
  modelSaveStatus,
  modelSettingsReady,
  modelSetupReady,
  status,
  step,
  onAcceptSafety,
  onBackToLanguage,
  onCopyDiagnostics,
  onLanguageChange,
  onLanguageContinue,
  onQuit,
  onRetryModelLoad,
  onRetryInstall,
  onSaveModel,
}: FirstRunStepContentProps) {
  if (step === "language") {
    return (
      <SetupWizardContent>
        <Typo.H3 as="h1">{copy.languageTitle}</Typo.H3>
        <Select
          value={language}
          onValueChange={(value) =>
            onLanguageChange(value as FirstRunLanguage)
          }
        >
          <SelectTrigger aria-label={copy.languageTitle}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="ko">한국어</SelectItem>
              <SelectItem value="en">English</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
        <Button type="button" onClick={onLanguageContinue}>
          {copy.continue}
        </Button>
      </SetupWizardContent>
    );
  }

  if (step === "safety") {
    return (
      <SetupWizardContent>
        <Stack gap="md">
          <Typo.H3 as="h1">{copy.safetyTitle}</Typo.H3>
          <Typo.Body>{copy.safetyBody}</Typo.Body>
          <SetupWizardList>
            {copy.safetyItems.map((item) => (
              <li key={item}>
                <Typo.Body as="span">{item}</Typo.Body>
              </li>
            ))}
          </SetupWizardList>
        </Stack>
        <ButtonContainer size="default">
          <Button type="button" variant="outline" onClick={onBackToLanguage}>
            {copy.back}
          </Button>
          <Button type="button" onClick={onAcceptSafety}>
            {copy.accept}
          </Button>
        </ButtonContainer>
      </SetupWizardContent>
    );
  }

  if (step === "install") {
    return (
      <SetupWizardContent>
        <Typo.H3 as="h1">{copy.installTitle}</Typo.H3>
        <Typo.Body>{error || status}</Typo.Body>
        {diagnosticsStatus && (
          <Typo.Caption>{diagnosticsStatus}</Typo.Caption>
        )}
        <ButtonContainer size="default">
          {error && (
            <>
              <Button type="button" onClick={onRetryInstall}>
                {copy.retry}
              </Button>
              <Button type="button" variant="outline" onClick={onCopyDiagnostics}>
                {copy.diagnostics}
              </Button>
              <Button type="button" variant="ghost" onClick={onQuit}>
                {copy.quit}
              </Button>
            </>
          )}
        </ButtonContainer>
      </SetupWizardContent>
    );
  }

  return (
    <FirstRunModelStep
      copy={copy}
      modelLoadFailed={modelLoadFailed}
      modelSaveStatus={modelSaveStatus}
      modelSettingsReady={modelSettingsReady}
      modelSetupReady={modelSetupReady}
      onRetryModelLoad={onRetryModelLoad}
      onSaveModel={onSaveModel}
    />
  );
}
