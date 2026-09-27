import { useAppLocale } from "@/app/copy.ts";
import { useSettingsUIStore } from "@/stores/settingsUIStore.ts";
import { ButlerConsolidationSettings } from "./ButlerConsolidationSettings";
import { BackupModelsSettings } from "./BackupModelsSettings";
import { useButlerModels } from "./hooks/useButlerModels";

/** Fallback & consolidation section: backup models and the memory consolidation model. */
export function FallbackConsolidationFields() {
  useAppLocale();
  const { draft, modelCatalog, models, activeModel, updateSettings } = useButlerModels();
  const saving = useSettingsUIStore((state) => state.saving);
  const registeredModels = (modelCatalog.registered_models ?? []).filter(
    (model) => model.registered === true && model.runtime_supported === true,
  );
  if (!draft) return null;
  return (
    <>
      <BackupModelsSettings models={registeredModels} draft={draft} saving={saving} onUpdate={updateSettings} />
      <ButlerConsolidationSettings models={models} activeModel={activeModel} draft={draft} onUpdate={updateSettings} />
    </>
  );
}
