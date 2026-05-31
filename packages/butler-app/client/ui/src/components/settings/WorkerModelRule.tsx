import {
  Input,
  SettingsField,
  Stack,
  SurfacePanel,
  Switch,
  Typo,
} from "@/butler-ds";
import { EMPTY_MODEL_CATALOG } from "@/app/constants.ts";
import {
  modelDisplayName,
  reasoningOptionLabel,
  tokenWindowLabel,
} from "@/app/utils.ts";
import { appCopy } from "@/app/copy.ts";
import { SettingsSelect } from "./SettingsFormComponents";
import type {
  AppModelSummary,
  ReasoningEffort,
  WorkerModelRule,
} from "@/app/types.ts";

interface WorkerModelRuleProps {
  rule: WorkerModelRule;
  models: AppModelSummary[];
  onUpdate: (partial: Partial<WorkerModelRule>) => void;
  onDraftUpdate: (partial: Partial<WorkerModelRule>) => void;
}

export function WorkerModelRuleItem({
  rule,
  models,
  onUpdate,
  onDraftUpdate,
}: WorkerModelRuleProps) {
  const settingsCopy = appCopy.settings;
  const settingsFields = settingsCopy.fields;
  const selectedModel =
    models.find((model) => model.model_ref === rule.model) ?? models[0];
  const reasoningOptions = selectedModel?.reasoning_efforts ?? ["none"];

  return (
    <SurfacePanel data-test-class="worker-model-rule" elevation="none">
      <Stack gap="md">
        <Typo.PanelSectionTitle as="h3">{rule.label}</Typo.PanelSectionTitle>
        <SettingsField
          data-test-class="settings-field worker-rule-enabled-field"
          label={settingsFields.enabled}
          control={
            <Switch
              checked={rule.enabled}
              onCheckedChange={(value) => onUpdate({ enabled: value })}
            />
          }
        />
        <SettingsField
          data-test-class="settings-field"
          label={settingsFields.condition}
          control={
            <Input
              value={rule.condition}
              onBlur={(event) => onUpdate({ condition: event.target.value })}
              onChange={(event) =>
                onDraftUpdate({ condition: event.target.value })
              }
            />
          }
        />
        <SettingsSelect
          label={settingsFields.model}
          value={
            selectedModel?.model_ref ?? EMPTY_MODEL_CATALOG.default_model_ref
          }
          onChange={(value) => {
            const nextModel = models.find(
              (model) => model.model_ref === value,
            );
            onUpdate({
              model: value,
              reasoning_effort:
                nextModel?.reasoning_efforts?.includes(
                  rule.reasoning_effort,
                ) &&
                !(
                  nextModel.provider_id === "local" &&
                  nextModel.local_reasoning_budget_ratio &&
                  rule.reasoning_effort === "none"
                )
                  ? rule.reasoning_effort
                  : (nextModel?.default_reasoning_effort ?? "medium"),
            });
          }}
          options={models.map((model) => ({
            value: model.model_ref,
            label: `${model.provider_label} / ${modelDisplayName(model)} (${tokenWindowLabel(model.context_window_tokens)})`,
          }))}
        />
        <SettingsSelect
          label={settingsFields.reasoning}
          value={rule.reasoning_effort}
          onChange={(value) =>
            onUpdate({ reasoning_effort: value as ReasoningEffort })
          }
          options={reasoningOptions.map((value) => ({
            value,
            label: reasoningOptionLabel(selectedModel, value),
          }))}
        />
      </Stack>
    </SurfacePanel>
  );
}
