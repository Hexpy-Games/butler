import { appCopy } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";
import { useSettingsUIStore } from "@/stores/settingsUIStore.ts";
import { runtimeModels } from "@/app/utils.ts";
import { Stack } from "@/butler-ds";
import { SettingsSection } from "./SettingsFormComponents";
import { ButlerModelSettings } from "./ButlerModelSettings";
import { ModelAddEditPage } from "./ModelAddEditPage";
import { ModelManagementPage } from "./ModelManagementPage";
import { WorkerModelRuleItem } from "./WorkerModelRule";
import type { WorkerModelRule } from "@/app/types.ts";

export function ModelsSettings() {
  const draft = useSettingsUIStore((state) => state.draft);
  const setDraft = useSettingsUIStore((state) => state.setDraft);
  const update = useSettingsUIStore((state) => state.update);
  const modelRoute = useSettingsUIStore((state) => state.modelRoute);
  const setSettings = useButlerStore((state) => state.setSettings);
  const modelCatalog = useButlerStore((state) => state.modelCatalog);

  const settingsCopy = appCopy.settings;
  const models = runtimeModels(modelCatalog);

  if (!draft) return null;
  const workerRules = draft.worker_model_rules ?? [];

  if (modelRoute.page === "management") return <ModelManagementPage />;
  if (modelRoute.page === "add") return <ModelAddEditPage />;
  if (modelRoute.page === "edit") {
    return <ModelAddEditPage modelRef={modelRoute.modelRef} />;
  }

  function workerRuleAt(index: number, partial: Partial<WorkerModelRule>) {
    return workerRules.map((rule, ruleIndex) =>
      ruleIndex === index ? { ...rule, ...partial } : rule,
    );
  }

  function updateWorkerRule(index: number, partial: Partial<WorkerModelRule>) {
    update({ worker_model_rules: workerRuleAt(index, partial) }, setSettings);
  }

  function draftWorkerRule(index: number, partial: Partial<WorkerModelRule>) {
    if (draft) {
      setDraft({ ...draft, worker_model_rules: workerRuleAt(index, partial) });
    }
  }

  return (
    <>
      <ButlerModelSettings />

      <SettingsSection title={settingsCopy.panels.workerModelRules}>
        <Stack gap="md">
          {workerRules.map((rule, index) => (
            <WorkerModelRuleItem
              key={rule.id}
              rule={rule}
              models={models}
              onUpdate={(partial) => updateWorkerRule(index, partial)}
              onDraftUpdate={(partial) => draftWorkerRule(index, partial)}
            />
          ))}
        </Stack>
      </SettingsSection>
    </>
  );
}
