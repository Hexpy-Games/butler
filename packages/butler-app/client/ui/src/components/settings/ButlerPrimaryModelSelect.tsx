import { EMPTY_MODEL_CATALOG } from "@/app/constants.ts";
import { appCopy } from "@/app/copy.ts";
import { modelDisplayName, tokenWindowLabel } from "@/app/utils.ts";
import { Button, Settings } from "@/butler-ds";
import { SettingsSelect } from "./SettingsFormComponents";
import type {
  AppModelSummary,
  SettingsView as SettingsData,
} from "@/app/types.ts";
import type { SettingsUpdate } from "./settingsTypes";

interface ButlerPrimaryModelSelectProps {
  models: AppModelSummary[];
  activeModel?: AppModelSummary;
  activeModelContextMax: number;
  draft: SettingsData;
  onManage: () => void;
  onUpdate: SettingsUpdate;
}

export function ButlerPrimaryModelSelect({
  models,
  activeModel,
  activeModelContextMax,
  draft,
  onManage,
  onUpdate,
}: ButlerPrimaryModelSelectProps) {
  const settingsCopy = appCopy.settings;
  const settingsFields = settingsCopy.fields;
  const settingsDescriptions = settingsCopy.descriptions;

  return (
    <SettingsSelect
      label={settingsFields.butlerModel}
      triggerTestClass="settings-primary-model-select"
      value={activeModel?.model_ref ?? EMPTY_MODEL_CATALOG.default_model_ref}
      description={settingsDescriptions.runtimeSupportedModelsOnly}
      controlWidth="full"
      action={
        <Button
          type="button"
          size="lg"
          variant="outline"
          data-test-class="settings-model-management-button"
          onClick={onManage}
        >
          <Settings size={15} /> {settingsCopy.modelManagement.manageButton}
        </Button>
      }
      onChange={(value) => {
        const nextModel = models.find((model) => model.model_ref === value);
        const nextModelMax =
          nextModel?.context_window_tokens ?? draft.context_window_tokens;
        const nextContextLimit =
          draft.context_window_tokens >= activeModelContextMax
            ? nextModelMax
            : Math.min(draft.context_window_tokens, nextModelMax);
        void onUpdate({
          model: value,
          reasoning_effort:
            nextModel?.reasoning_efforts?.includes(draft.reasoning_effort) &&
            !(
              nextModel.provider_id === "local" &&
              nextModel.local_reasoning_budget_ratio &&
              draft.reasoning_effort === "none"
            )
              ? draft.reasoning_effort
              : (nextModel?.default_reasoning_effort ?? "medium"),
          context_window_tokens: nextContextLimit,
        });
      }}
      options={models.map((model) => ({
        value: model.model_ref,
        label: `${model.provider_label} / ${modelDisplayName(model)} (${tokenWindowLabel(model.context_window_tokens)})`,
      }))}
    />
  );
}
