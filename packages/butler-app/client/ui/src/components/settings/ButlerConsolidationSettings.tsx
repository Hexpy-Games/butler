import { appCopy } from "@/app/copy.ts";
import { reasoningOptionLabel } from "@/app/utils.ts";
import type {
  AppModelSummary,
  ReasoningEffort,
  SettingsView,
} from "@/app/types.ts";
import { SettingsSelect } from "./SettingsFormComponents";
import { consolidationModelOptionsFrom } from "./PersonalizationSettingsOptions";

export function ButlerConsolidationSettings({
  models,
  activeModel,
  draft,
  onUpdate,
}: {
  models: AppModelSummary[];
  activeModel?: AppModelSummary;
  draft: SettingsView;
  onUpdate: (partial: Partial<SettingsView>) => void;
}) {
  const settingsCopy = appCopy.settings;
  const settingsFields = settingsCopy.fields;
  const settingsDescriptions = settingsCopy.descriptions;
  const consolidationModel =
    draft.consolidation_model === "default"
      ? activeModel
      : (models.find((item) => item.model_ref === draft.consolidation_model) ??
        activeModel);

  return (
    <>
      <SettingsSelect
        label={settingsFields.consolidationModel}
        value={draft.consolidation_model}
        description={settingsDescriptions.consolidationModel}
        onChange={(value) => onUpdate({ consolidation_model: value })}
        options={consolidationModelOptionsFrom(
          models,
          settingsCopy.options.consolidationModelDefault,
          settingsDescriptions.consolidationModelDefault,
        )}
      />
      <SettingsSelect
        label={settingsFields.reasoning}
        value={draft.consolidation_reasoning_effort}
        onChange={(value) =>
          onUpdate({ consolidation_reasoning_effort: value as ReasoningEffort })
        }
        options={(consolidationModel?.reasoning_efforts ?? ["none"]).map(
          (value) => ({
            value,
            label: reasoningOptionLabel(consolidationModel, value),
          }),
        )}
      />
    </>
  );
}
