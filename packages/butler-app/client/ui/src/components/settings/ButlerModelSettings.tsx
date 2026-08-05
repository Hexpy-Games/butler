import { appCopy } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";
import { useSettingsUIStore } from "@/stores/settingsUIStore.ts";
import {
  reasoningOptionLabel,
  tokenWindowLabel,
  runtimeModels,
} from "@/app/utils.ts";
import { notifyStatus } from "@/app/notifications.ts";
import {
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
  SettingsTokenInput,
  SettingsPercentInput,
} from "./SettingsFormComponents";
import { ratioToPercent } from "./settingsUtils";
import { useLocalReasoningBudget } from "./hooks/useLocalReasoningBudget";
import { ButlerPrimaryModelSelect } from "./ButlerPrimaryModelSelect";
import { ButlerConsolidationSettings } from "./ButlerConsolidationSettings";
import { BackupModelsSettings } from "./BackupModelsSettings";
import type {
  ReasoningEffort,
  SettingsView as SettingsData,
} from "@/app/types.ts";

export function ButlerModelSettings() {
  const draft = useSettingsUIStore((state) => state.draft);
  const update = useSettingsUIStore((state) => state.update);
  const saving = useSettingsUIStore((state) => state.saving);
  const openModelManagement = useSettingsUIStore(
    (state) => state.openModelManagement,
  );
  const setSettings = useButlerStore((state) => state.setSettings);
  const modelCatalog = useButlerStore((state) => state.modelCatalog);
  const setModelCatalog = useButlerStore((state) => state.setModelCatalog);

  const settingsCopy = appCopy.settings;
  const models = runtimeModels(modelCatalog);
  const registeredModels = (modelCatalog.registered_models ?? []).filter(
    (model) => model.registered === true && model.runtime_supported === true,
  );
  const settingsFields = settingsCopy.fields;
  const settingsDescriptions = settingsCopy.descriptions;

  if (!draft) return null;

  const activeModel =
    models.find((item) => item.model_ref === draft.model) ?? models[0];
  const activeModelContextMax = activeModel?.context_window_tokens ?? 200_000;
  const activeLocalModel =
    activeModel?.provider_id === "local" ? activeModel : null;
  const { updateActiveLocalReasoningBudget } = useLocalReasoningBudget(
    activeLocalModel,
    draft,
    setModelCatalog,
    update,
    settingsCopy,
    setSettings,
  );
  const updateSettings = (partial: Parameters<typeof update>[0]) =>
    update(partial, setSettings);

  return (
    <SettingsSection title={settingsCopy.panels.butlerModel}>
      <ButlerPrimaryModelSelect
        models={models}
        activeModel={activeModel}
        activeModelContextMax={activeModelContextMax}
        draft={draft}
        onManage={openModelManagement}
        onUpdate={updateSettings}
      />
      <BackupModelsSettings
        models={registeredModels}
        draft={draft}
        saving={saving}
        onUpdate={updateSettings}
      />
      <SettingsSelect
        label={settingsFields.butlerReasoning}
        triggerTestClass="settings-primary-reasoning-select"
        value={draft.reasoning_effort}
        onChange={(value) =>
          update({ reasoning_effort: value as ReasoningEffort }, setSettings)
        }
        options={(activeModel?.reasoning_efforts ?? ["none"]).map((value) => ({
          value,
          label: reasoningOptionLabel(activeModel, value),
        }))}
      />
      <ButlerConsolidationSettings
        models={models}
        activeModel={activeModel}
        draft={draft}
        onUpdate={updateSettings}
      />
      {activeLocalModel && (
        <SettingsPercentInput
          label={settingsFields.localReasoningBudget}
          value={ratioToPercent(activeLocalModel.local_reasoning_budget_ratio)}
          description={settingsDescriptions.localReasoningBudget}
          disabled={saving}
          onCommit={(value) => updateActiveLocalReasoningBudget(value)}
        />
      )}
      <SettingsTokenInput
        label={settingsFields.contextLimit}
        value={draft.context_window_tokens}
        min={1_000}
        max={activeModelContextMax}
        description={settingsDescriptions.contextLimit(
          tokenWindowLabel(activeModelContextMax),
        )}
        onCommit={(value, clamped) => {
          void update({ context_window_tokens: value }, setSettings).then(
            () => {
              if (clamped) {
                notifyStatus(
                  settingsDescriptions.contextLimitClamped(
                    value.toLocaleString("en-US"),
                  ),
                  {
                    id: "settings-context-limit",
                    tone: "ok",
                  },
                );
              }
            },
          );
        }}
      />
      <SettingsSelect
        label={settingsFields.access}
        value={draft.access_mode}
        onChange={(value) =>
          update(
            { access_mode: value as SettingsData["access_mode"] },
            setSettings,
          )
        }
        options={[
          { value: "full_access", label: appCopy.permissions.fullAccess },
          { value: "ask_first", label: appCopy.permissions.askFirst },
          { value: "read_only", label: appCopy.permissions.readOnly },
        ]}
      />
      <SettingsSwitch
        label={settingsFields.planModeDefault}
        checked={draft.plan_mode_default}
        onChange={(value) => update({ plan_mode_default: value }, setSettings)}
      />
    </SettingsSection>
  );
}
