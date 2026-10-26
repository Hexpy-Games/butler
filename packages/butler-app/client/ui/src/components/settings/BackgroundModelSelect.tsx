import { appCopy, useAppLocale } from "@/app/copy.ts";
import type { AppModelSummary, SettingsView } from "@/app/types.ts";
import { modelDisplayName, tokenWindowLabel } from "@/app/utils.ts";
import { ProviderMark } from "./ProviderMark";
import { SettingsSelect } from "./SettingsFormComponents";
import type { SettingsUpdate } from "./settingsTypes";

interface BackgroundModelSelectProps {
  models: AppModelSummary[];
  draft: SettingsView;
  onUpdate: SettingsUpdate;
}

export function BackgroundModelSelect({ models, draft, onUpdate }: BackgroundModelSelectProps) {
  useAppLocale();
  return (
    <SettingsSelect
      settingId="background-model"
      label={appCopy.settings.fields.backgroundModel}
      triggerTestClass="settings-background-model-select"
      value={draft.background_model ?? "default"}
      description={appCopy.settings.descriptions.backgroundModel}
      onChange={(value) => { void onUpdate({ background_model: value }); }}
      options={[
        { value: "default", label: appCopy.settings.fields.backgroundModelUnset },
        ...models.map((model) => ({
          value: model.model_ref,
          label: `${model.provider_label} / ${modelDisplayName(model)} (${tokenWindowLabel(model.context_window_tokens)})`,
          icon: <ProviderMark providerId={model.provider_id} platform={model.platform} />,
        })),
      ]}
    />
  );
}
