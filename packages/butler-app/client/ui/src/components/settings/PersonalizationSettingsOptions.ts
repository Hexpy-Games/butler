import { modelDisplayName, tokenWindowLabel } from "@/app/utils.ts";
import type { AppModelSummary, PersonaPresetView } from "@/app/types.ts";
import type { SettingsCopy } from "./settingsTypes";

export type ProfileFieldKey = "butler_nickname" | "principal_name" | "preferred_address";

export function profileFieldOptions(
  fields: SettingsCopy["fields"],
  placeholders: SettingsCopy["placeholders"],
): Array<{ key: ProfileFieldKey; label: string; placeholder: string }> {
  return [
    { key: "butler_nickname", label: fields.butlerNickname, placeholder: placeholders.butlerNickname },
    { key: "principal_name", label: fields.principalName, placeholder: placeholders.principalName },
    { key: "preferred_address", label: fields.preferredAddress, placeholder: placeholders.preferredAddress },
  ];
}

export function personaPresetOptionsFrom(
  presets: PersonaPresetView[],
  customLabel: string,
) {
  return [
    { value: "custom", label: customLabel },
    ...presets.map((preset) => ({
      value: preset.name,
      label: preset.label,
      description: preset.preview,
    })),
  ];
}

export function profilingOptionsFrom(
  settingsCopy: SettingsCopy,
  descriptions: SettingsCopy["descriptions"],
) {
  return [
    { value: "off", label: settingsCopy.options.profilingOff, description: descriptions.profilingOff },
    { value: "basic", label: settingsCopy.options.profilingBasic, description: descriptions.profilingBasic },
    { value: "deep", label: settingsCopy.options.profilingDeep, description: descriptions.profilingDeep },
  ];
}

export function profilingExtractorModelOptionsFrom(
  models: AppModelSummary[],
  defaultLabel: string,
  defaultDescription: string,
) {
  return [
    { value: "default", label: defaultLabel, description: defaultDescription },
    ...models.map((model) => ({
      value: model.model_ref,
      label: `${model.provider_label} / ${modelDisplayName(model)} (${tokenWindowLabel(model.context_window_tokens)})`,
    })),
  ];
}

export const consolidationModelOptionsFrom = profilingExtractorModelOptionsFrom;
