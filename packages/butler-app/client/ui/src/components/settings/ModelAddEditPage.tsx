import { useEffect, useMemo, useState } from "react";
import { Stack } from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";
import { useSettingsUIStore } from "@/stores/settingsUIStore.ts";
import { SettingsSelect } from "./SettingsFormComponents";
import { HostedModelForm } from "./HostedModelForm";
import { LocalModelSettings } from "./LocalModelSettings";
import { ModelRouteFrame } from "./ModelRouteFrame";
import {
  LOCAL_PROVIDER_ID,
  hostedModelProviders,
  registeredModels,
} from "./modelManagementUtils";
import type { ProviderAuthMethod } from "@/app/types.ts";

interface ModelAddEditPageProps {
  allowedAuthMethods?: ProviderAuthMethod[];
  modelRef?: string;
}

export function ModelAddEditPage({
  allowedAuthMethods,
  modelRef,
}: ModelAddEditPageProps) {
  const modelCatalog = useButlerStore((state) => state.modelCatalog);
  const route = useSettingsUIStore((state) => state.modelRoute);
  const copy = appCopy.settings.modelManagement;
  const editingModel = useMemo(
    () => registeredModels(modelCatalog).find((model) => model.model_ref === modelRef),
    [modelCatalog, modelRef],
  );
  const hostedProviderOptions = useMemo(
    () =>
      hostedModelProviders(modelCatalog, allowedAuthMethods).map((provider) => ({
        value: provider.provider_id,
        label: provider.provider_label,
      })),
    [allowedAuthMethods, modelCatalog],
  );
  const providerOptions = useMemo(
    () => [
      ...hostedProviderOptions,
      { value: LOCAL_PROVIDER_ID, label: appCopy.settings.options.local },
    ],
    [hostedProviderOptions],
  );
  const [providerId, setProviderId] = useState(
    editingModel?.provider_id ?? hostedProviderOptions[0]?.value ?? LOCAL_PROVIDER_ID,
  );
  useEffect(() => {
    if (editingModel) setProviderId(editingModel.provider_id);
  }, [editingModel?.model_ref, editingModel?.provider_id]);
  useEffect(() => {
    if (editingModel || providerOptions.some((option) => option.value === providerId)) {
      return;
    }
    setProviderId(providerOptions[0]?.value ?? LOCAL_PROVIDER_ID);
  }, [editingModel, providerId, providerOptions]);
  const isLocal = providerId === LOCAL_PROVIDER_ID;
  const title = route.page === "edit" ? copy.editTitle : copy.addTitle;

  return (
    <ModelRouteFrame title={title}>
      <Stack gap="md">
        {route.page !== "edit" && (
          <SettingsSelect
            label={copy.provider}
            triggerTestClass="model-add-provider-select"
            value={providerId}
            onChange={setProviderId}
            options={providerOptions}
          />
        )}
        {isLocal ? (
          <LocalModelSettings
            initialEditModel={editingModel?.provider_id === LOCAL_PROVIDER_ID ? editingModel : null}
            hideRegisteredList
          />
        ) : (
          <HostedModelForm
            allowedAuthMethods={allowedAuthMethods}
            editingModel={editingModel}
            providerId={providerId}
            onProviderIdChange={setProviderId}
            showProviderSelect={false}
          />
        )}
      </Stack>
    </ModelRouteFrame>
  );
}
