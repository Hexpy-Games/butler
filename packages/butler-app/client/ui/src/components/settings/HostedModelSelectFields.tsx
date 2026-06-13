import { appCopy } from "@/app/copy.ts";
import { SettingsSelect } from "./SettingsFormComponents";
import { modelOptionLabel } from "./modelManagementUtils";
import type { AppModelSummary, ModelCatalogView } from "@/app/types.ts";

interface HostedModelSelectFieldsProps {
  modelOptions: AppModelSummary[];
  modelRef: string;
  providerId: string;
  providers: ModelCatalogView["providers"];
  showProviderSelect: boolean;
  onModelRefChange: (modelRef: string) => void;
  onProviderIdChange: (providerId: string) => void;
}

export function HostedModelSelectFields({
  modelOptions,
  modelRef,
  providerId,
  providers,
  showProviderSelect,
  onModelRefChange,
  onProviderIdChange,
}: HostedModelSelectFieldsProps) {
  const copy = appCopy.settings.modelManagement;

  return (
    <>
      {showProviderSelect && (
        <SettingsSelect
          label={copy.provider}
          triggerTestClass="hosted-model-provider-select"
          value={providerId}
          onChange={onProviderIdChange}
          options={providers.map((provider) => ({
            value: provider.provider_id,
            label: provider.provider_label,
          }))}
        />
      )}
      <SettingsSelect
        label={copy.model}
        triggerTestClass="hosted-model-select"
        value={modelRef}
        onChange={onModelRefChange}
        options={modelOptions.map((model) => ({
          value: model.model_ref,
          label: modelOptionLabel(model),
        }))}
      />
    </>
  );
}
