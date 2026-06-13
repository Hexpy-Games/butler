import {
  firstRunCopy,
  type FirstRunLanguage,
} from "@/app/firstRunSetup.ts";
import {
  Button,
  ButtonContainer,
  Field,
  FieldDescription,
  FieldLabel,
  NativeSelect,
  NativeSelectOption,
  SetupWizardContent,
  Stack,
  Typo,
} from "@/butler-ds";
import type { FirstRunModelOption } from "./useFirstRunModelSetup";

type FirstRunCopy = (typeof firstRunCopy)[FirstRunLanguage];

interface FirstRunModelStepProps {
  copy: FirstRunCopy;
  modelLoadFailed: boolean;
  modelOptions: FirstRunModelOption[];
  modelSaveStatus: string;
  modelSaving: boolean;
  selectedDescription: string;
  selectedModel: string;
  onModelChange: (modelRef: string) => void;
  onRetryModelLoad: () => void;
  onSaveModel: () => void;
}

export function FirstRunModelStep({
  copy,
  modelLoadFailed,
  modelOptions,
  modelSaveStatus,
  modelSaving,
  selectedDescription,
  selectedModel,
  onModelChange,
  onRetryModelLoad,
  onSaveModel,
}: FirstRunModelStepProps) {
  return (
    <SetupWizardContent>
      <Stack gap="md">
        <Typo.H3 as="h1">{copy.modelTitle}</Typo.H3>
        <Typo.Body>{copy.modelBody}</Typo.Body>
      </Stack>
      <Field>
        <FieldLabel htmlFor="first-run-model">
          {copy.modelSelectLabel}
        </FieldLabel>
        <NativeSelect
          id="first-run-model"
          stretch
          value={selectedModel}
          onChange={(event) => onModelChange(event.currentTarget.value)}
          aria-label={copy.modelSelectLabel}
          disabled={modelLoadFailed || modelOptions.length === 0 || modelSaving}
        >
          {modelOptions.map((model) => (
            <NativeSelectOption key={model.value} value={model.value}>
              {model.label}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        {(selectedDescription || modelSaveStatus) && (
          <FieldDescription>
            {modelSaveStatus || selectedDescription}
          </FieldDescription>
        )}
      </Field>
      <ButtonContainer size="default">
        {modelLoadFailed ? (
          <Button type="button" variant="outline" onClick={onRetryModelLoad}>
            {copy.modelRetry}
          </Button>
        ) : (
          <Button
            type="button"
            onClick={onSaveModel}
            disabled={!selectedModel || modelSaving}
          >
            {modelSaving ? copy.modelSaving : copy.modelSave}
          </Button>
        )}
      </ButtonContainer>
    </SetupWizardContent>
  );
}
