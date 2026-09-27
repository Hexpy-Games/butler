import { useButlerStore } from "@/app/store.ts";
import { runtimeModels } from "@/app/utils.ts";
import { useSettingsUIStore } from "@/stores/settingsUIStore.ts";

/** The settings draft and runtime models the Butler model sections share. */
export function useButlerModels() {
  const draft = useSettingsUIStore((state) => state.draft);
  const update = useSettingsUIStore((state) => state.update);
  const setSettings = useButlerStore((state) => state.setSettings);
  const modelCatalog = useButlerStore((state) => state.modelCatalog);
  const models = runtimeModels(modelCatalog);
  const activeModel = models.find((item) => item.model_ref === draft?.model) ?? models[0];
  const updateSettings = (partial: Parameters<typeof update>[0]) => update(partial, setSettings);
  return { draft, update, setSettings, modelCatalog, models, activeModel, updateSettings };
}
