import { useAppLocale } from "@/app/copy.ts";
import { useId, useState } from "react";
import { Button, Collapsible, SettingsField, Stack } from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import { modelDisplayName } from "@/app/utils.ts";
import type { AppModelSummary, SettingsView } from "@/app/types.ts";
import { useSettingsUIStore } from "@/stores/settingsUIStore.ts";
import { BackupModelsSettings } from "./BackupModelsSettings";
import { useButlerModels } from "./hooks/useButlerModels";

/** "Off", or the backup models in the order they take over. */
function backupSummary(fallback: SettingsView["model_fallback"], models: AppModelSummary[]): string {
  const copy = appCopy.settings.backupModels;
  if (!fallback.enabled) return copy.off;
  if (fallback.models.length === 0) return copy.empty;
  return fallback.models
    .map((ref) => {
      const model = models.find((item) => item.model_ref === ref);
      return model ? modelDisplayName(model) : ref;
    })
    .join(" → ");
}

/** Backup models as one summary line; Edit reveals the full editor below it. */
export function BackupModelsSummary() {
  useAppLocale();
  const { draft, modelCatalog, updateSettings } = useButlerModels();
  const saving = useSettingsUIStore((state) => state.saving);
  const [editing, setEditing] = useState(false);
  const editorId = useId();
  if (!draft) return null;
  const copy = appCopy.settings.backupModels;
  const registeredModels = (modelCatalog.registered_models ?? []).filter(
    (model) => model.registered === true && model.runtime_supported === true,
  );

  return (
    <>
      <SettingsField
        settingId="backup-models-summary"
        data-test-class="settings-backup-models-summary"
        label={backupSummary(draft.model_fallback, registeredModels)}
        description={copy.summaryDescription}
        control={
          <Button
            type="button"
            size="sm"
            variant="outline"
            aria-controls={editorId}
            aria-expanded={editing}
            aria-label={editing ? undefined : copy.editLabel}
            onClick={() => setEditing(!editing)}
          >
            {editing ? copy.done : copy.edit}
          </Button>
        }
      />
      <Collapsible open={editing} id={editorId}>
        <Stack gap="xl">
          <BackupModelsSettings models={registeredModels} draft={draft} saving={saving} onUpdate={updateSettings} />
        </Stack>
      </Collapsible>
    </>
  );
}
