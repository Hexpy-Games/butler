import { useAppLocale } from "@/app/copy.ts";
import { SettingsField, Stack, Switch } from "@/butler-ds";
import { useId } from "react";
import { appCopy } from "@/app/copy.ts";
import type { AppModelSummary, SettingsView } from "@/app/types.ts";
import type { SettingsUpdate } from "./settingsTypes";
import { BackupModelCards } from "./BackupModelCards";
import { BackupModelPicker } from "./BackupModelPicker";
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
  useAppLocale();
  const copy = appCopy.settings.backupModels;
  const descriptionId = useId();
  const listDescriptionId = useId();
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
    <>
      <SettingsField
        id="model-fallback-enabled"
        data-test-class="settings-backup-models settings-backup-models-toggle"
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
        <SettingsField
          data-test-class="settings-backup-models-list-field"
          label={copy.title}
          description={copy.description}
          descriptionId={listDescriptionId}
          controlWidth="full"
          control={
            <Stack gap="sm" cross="start">
              <BackupModelPicker
                models={candidates}
                fallback={fallback}
                saving={saving}
                onUpdate={onUpdate}
              />
              <Stack.Item alignSelf="stretch">
                <BackupModelCards
                  models={models}
                  fallback={fallback}
                  saving={saving}
                  onUpdate={updateModels}
                />
              </Stack.Item>
            </Stack>
          }
        />
      )}
    </>
  );
}

export { addBackupModel } from "./backupModelsUtils";
