import {
  SettingsField,
  Stack,
  Switch,
  Typo,
} from "@/butler-ds";
import { useId } from "react";
import { appCopy } from "@/app/copy.ts";
import type { AppModelSummary, SettingsView } from "@/app/types.ts";
import type { SettingsUpdate } from "./settingsTypes";
import { BackupModelCards } from "./BackupModelCards";
import { BackupModelPicker } from "./BackupModelPicker";
import { BackupModelsDescription } from "./BackupModelsDescription";
import { selectableBackupModels } from "./backupModelsUtils";

interface BackupModelsSettingsProps {
  models: AppModelSummary[];
  draft: SettingsView;
  saving: boolean;
  onUpdate: SettingsUpdate;
}

export function BackupModelsSettings({
  models,
  draft,
  saving,
  onUpdate,
}: BackupModelsSettingsProps) {
  const copy = appCopy.settings.backupModels;
  const descriptionId = useId();
  const fallback = draft.model_fallback;
  const candidates = selectableBackupModels(
    models,
    draft.model,
    fallback.models,
  );

  function updateModels(modelsInOrder: string[]) {
    void onUpdate({
      model_fallback: {
        enabled: fallback.enabled,
        models: modelsInOrder,
      },
    });
  }

  return (
    <Stack gap="md" data-test-class="settings-backup-models">
      <Typo.Body>{copy.title}</Typo.Body>
      <SettingsField
        id="model-fallback-enabled"
        data-test-class="settings-backup-models-toggle"
        label={copy.enabled}
        description={copy.enabledDescription}
        descriptionId={descriptionId}
        control={
          <Switch
            id="model-fallback-enabled"
            aria-describedby={descriptionId}
            checked={fallback.enabled}
            disabled={saving}
            onCheckedChange={(enabled) =>
              void onUpdate({
                model_fallback: { enabled, models: fallback.models },
              })
            }
          />
        }
      />
      {fallback.enabled && (
        <Stack gap="sm">
          <Stack align="row" cross="center" justify="between" gap="sm">
            <BackupModelsDescription />
            <BackupModelPicker
              models={candidates}
              fallback={fallback}
              saving={saving}
              onUpdate={onUpdate}
            />
          </Stack>
          <BackupModelCards
            models={models}
            fallback={fallback}
            saving={saving}
            onUpdate={updateModels}
          />
        </Stack>
      )}
    </Stack>
  );
}

export { addBackupModel } from "./backupModelsUtils";
