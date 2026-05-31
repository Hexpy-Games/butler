import { Input, SettingsField, Stack } from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";

interface LocalModelManualFormProps {
  manualModelId: string;
  setManualModelId: (value: string) => void;
  manualDisplayName: string;
  setManualDisplayName: (value: string) => void;
  manualContext: string;
  setManualContext: (value: string) => void;
}

export function LocalModelManualForm({
  manualModelId,
  setManualModelId,
  manualDisplayName,
  setManualDisplayName,
  manualContext,
  setManualContext,
}: LocalModelManualFormProps) {
  const copy = appCopy.settings.localModels;

  return (
    <Stack gap="md">
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
    </Stack>
  );
}
