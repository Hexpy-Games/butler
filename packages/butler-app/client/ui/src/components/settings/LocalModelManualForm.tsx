import { useAppLocale } from "@/app/copy.ts";
import { Input, SettingsField } from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import type { ResponseTimeoutLimits } from "@/app/types.ts";
import { SettingsSwitch } from "./SettingsFormComponents";

export interface LocalModelImageInput {
  checked: boolean;
  setChecked: (value: boolean) => void;
}

/** The response time limit field: seconds as typed, and the agent's limits. */
export interface LocalModelResponseTimeout {
  value: string;
  setValue: (value: string) => void;
  invalid: boolean;
  limits?: ResponseTimeoutLimits;
}

function seconds(milliseconds: number | undefined): number | undefined {
  return milliseconds === undefined ? undefined : milliseconds / 1000;
}

interface LocalModelManualFormProps {
  manualModelId: string;
  setManualModelId: (value: string) => void;
  manualDisplayName: string;
  setManualDisplayName: (value: string) => void;
  manualContext: string;
  setManualContext: (value: string) => void;
  responseTimeout: LocalModelResponseTimeout;
  imageInput: LocalModelImageInput;
}

export function LocalModelManualForm({
  manualModelId,
  setManualModelId,
  manualDisplayName,
  setManualDisplayName,
  manualContext,
  setManualContext,
  responseTimeout,
  imageInput,
}: LocalModelManualFormProps) {
  useAppLocale();
  const copy = appCopy.settings.localModels;
  const limits = responseTimeout.limits;

  return (
    <>
      <SettingsField
        id="local-model-id"
        data-test-class="settings-field"
        label={copy.modelId}
        control={
          <Input
            id="local-model-id"
            value={manualModelId}
            onChange={(event) => setManualModelId(event.target.value)}
          />
        }
      />
      <SettingsField
        id="local-model-display-name"
        data-test-class="settings-field"
        label={copy.displayName}
        control={
          <Input
            id="local-model-display-name"
            value={manualDisplayName}
            onChange={(event) => setManualDisplayName(event.target.value)}
          />
        }
      />
      <SettingsField
        id="local-model-context"
        data-test-class="settings-field"
        label={copy.maxContext}
        control={
          <Input
            id="local-model-context"
            inputMode="numeric"
            value={manualContext}
            onChange={(event) => setManualContext(event.target.value)}
          />
        }
      />
      <SettingsField
        id="local-model-response-timeout"
        data-test-class="settings-field"
        label={copy.responseTimeout}
        description={copy.responseTimeoutDescription(seconds(limits?.default_ms))}
        error={
          responseTimeout.invalid
            ? copy.responseTimeoutError(
                limits && { min: limits.min_ms / 1000, max: limits.max_ms / 1000 },
              )
            : undefined
        }
        control={
          <Input
            id="local-model-response-timeout"
            inputMode="decimal"
            value={responseTimeout.value}
            onChange={(event) => responseTimeout.setValue(event.target.value)}
          />
        }
      />
      <SettingsSwitch
        id="local-model-image-input"
        label={copy.imageInput}
        checked={imageInput.checked}
        onChange={imageInput.setChecked}
      />
    </>
  );
}
