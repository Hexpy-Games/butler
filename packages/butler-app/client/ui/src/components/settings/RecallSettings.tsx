import { useAppLocale } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";
import { modelDisplayName, runtimeModels } from "@/app/utils.ts";
import { useSettingsUIStore } from "@/stores/settingsUIStore.ts";
import { Stack } from "@/butler-ds";
import { SettingsSelect } from "./SettingsSelect";

export function RecallSettings() {
  const ko = useAppLocale() === "ko-KR";
  const draft = useSettingsUIStore((state) => state.draft);
  const update = useSettingsUIStore((state) => state.update);
  const saving = useSettingsUIStore((state) => state.saving);
  const setSettings = useButlerStore((state) => state.setSettings);
  const catalog = useButlerStore((state) => state.modelCatalog);
  if (!draft) return null;
  const models = runtimeModels(catalog).filter((model) => model.enabled !== false && model.registered === true);
  return <Stack gap="md">
    <SettingsSelect settingId="recall-mode" label={ko ? "회상 방식" : "Recall"}
      description={ko ? "정확하게 회상하면 몇 초 더 걸릴 수 있어요." : "More accurate recall can take a few seconds longer."}
      value={draft.recall_mode} disabled={saving}
      onChange={(value) => { void update({ recall_mode: value as "faster" | "accurate" }, setSettings); }}
      options={[{ value: "faster", label: ko ? "빠르게" : "Faster" }, { value: "accurate", label: ko ? "정확하게" : "More accurate" }]} />
    {draft.recall_mode === "accurate" && <SettingsSelect settingId="recall-judge-model"
      label={ko ? "회상 모델" : "Recall model"} value={draft.recall_judge_model} disabled={saving}
      onChange={(value) => { void update({ recall_judge_model: value }, setSettings); }}
      options={[{ value: "default", label: ko ? "기억 모델과 동일" : "Same as memory model" },
        ...models.map((model) => ({ value: model.model_ref, label: `${model.provider_label} / ${modelDisplayName(model)}` }))]} />}
  </Stack>;
}
