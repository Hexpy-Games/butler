import { appCopy } from "@/app/copy.ts";
import { reasoningOptionLabel } from "@/app/utils.ts";
import type {
  AppModelSummary,
  ReasoningEffort,
} from "@/app/types.ts";
import { SettingsSelect } from "./SettingsFormComponents";
import {
  profilingExtractorModelOptionsFrom,
  profilingOptionsFrom,
} from "./PersonalizationSettingsOptions";
import type { PersonalizationDraft } from "./settingsTypes";

type SetPersonalizationDraft = (
  draft:
    | PersonalizationDraft
    | ((current: PersonalizationDraft) => PersonalizationDraft),
) => void;

export function PersonalizationProfilingSettings({
  models,
  butlerModel,
  profilingDraft,
  saving,
  personalizationLoaded,
  setPersonalizationDraft,
}: {
  models: AppModelSummary[];
  butlerModel?: AppModelSummary;
  profilingDraft: PersonalizationDraft["profiling"];
  saving: boolean;
  personalizationLoaded: boolean;
  setPersonalizationDraft: SetPersonalizationDraft;
}) {
  const settingsCopy = appCopy.settings;
  const settingsFields = settingsCopy.fields;
  const settingsDescriptions = settingsCopy.descriptions;
  const extractorModel =
    profilingDraft.extractorModel === "default"
      ? butlerModel
      : (models.find((item) => item.model_ref === profilingDraft.extractorModel) ??
        butlerModel);
  const disabled = saving || !personalizationLoaded;

  return (
    <>
      <SettingsSelect
        label={settingsFields.profilingMode}
        description={settingsDescriptions.profilingMode}
        controlWidth="full"
        value={profilingDraft.mode}
        onChange={(mode) =>
          setPersonalizationDraft((current) => ({
            ...current,
            profiling: {
              ...current.profiling,
              mode: mode === "basic" || mode === "deep" ? mode : "off",
            },
          }))
        }
        options={profilingOptionsFrom(settingsCopy, settingsDescriptions)}
        disabled={disabled}
      />
      <SettingsSelect
        label={settingsFields.profilingExtractorModel}
        description={settingsDescriptions.profilingExtractorModel}
        controlWidth="full"
        value={profilingDraft.extractorModel}
        onChange={(extractorModel) =>
          setPersonalizationDraft((current) => ({
            ...current,
            profiling: {
              ...current.profiling,
              extractorModel: extractorModel || "default",
            },
          }))
        }
        options={profilingExtractorModelOptionsFrom(
          models,
          settingsCopy.options.profilingExtractorDefault,
          settingsDescriptions.profilingExtractorDefault,
        )}
        disabled={disabled}
      />
      <SettingsSelect
        label={settingsFields.reasoning}
        value={profilingDraft.extractorReasoningEffort}
        onChange={(extractorReasoningEffort) =>
          setPersonalizationDraft((current) => ({
            ...current,
            profiling: {
              ...current.profiling,
              extractorReasoningEffort:
                extractorReasoningEffort as ReasoningEffort,
            },
          }))
        }
        options={(extractorModel?.reasoning_efforts ?? ["none"]).map((value) => ({
          value,
          label: reasoningOptionLabel(extractorModel, value),
        }))}
        disabled={disabled}
      />
    </>
  );
}
