import { appCopy } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";
import { modelDisplayName, runtimeModels } from "@/app/utils.ts";
import { useSettingsUIStore } from "@/stores/settingsUIStore.ts";
import { SettingsSelect } from "./SettingsSelect";

export function RecallSettings() {
  const copy = appCopy.settings;
  const draft = useSettingsUIStore((state) => state.draft);
  const update = useSettingsUIStore((state) => state.update);
  const saving = useSettingsUIStore((state) => state.saving);
  const setSettings = useButlerStore((state) => state.setSettings);
  const catalog = useButlerStore((state) => state.modelCatalog);
  if (!draft) return null;
  const models = runtimeModels(catalog).filter((model) => model.enabled !== false && model.registered === true);
  return <>
    <SettingsSelect settingId="recall-mode" label={copy.fields.recallMode}
      description={copy.descriptions.recallMode}
      value={draft.recall_mode} disabled={saving}
      onChange={(value) => { void update({ recall_mode: value as "faster" | "accurate" }, setSettings); }}
      options={[{ value: "faster", label: copy.recallOptions.faster }, { value: "accurate", label: copy.recallOptions.accurate }]} />
    {draft.recall_mode === "accurate" && <SettingsSelect settingId="recall-judge-model"
      label={copy.fields.recallModel} value={draft.recall_judge_model} disabled={saving}
      onChange={(value) => { void update({ recall_judge_model: value }, setSettings); }}
      options={[{ value: "default", label: copy.recallOptions.sameAsMemoryModel },
        ...models.map((model) => ({ value: model.model_ref, label: `${model.provider_label} / ${modelDisplayName(model)}` }))]} />}
  </>;
}
